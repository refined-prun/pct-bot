import type { Attachment, Message, ThreadChannel } from "discord.js";
import type { Octokit } from "@octokit/rest";
import { extname } from "node:path";

const mediaTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ThreadAttachment {
  id: string;
  name: string;
  url: string;
  size: number;
  contentType: string;
  messageUrl: string;
  author: string;
}

export function collectAttachments(messages: Message[]): ThreadAttachment[] {
  const attachments = new Map<string, ThreadAttachment>();
  for (const message of messages) {
    const add = (attachment: Attachment) => {
      if (attachments.has(attachment.id)) return;
      attachments.set(attachment.id, {
        id: attachment.id,
        name: attachment.name,
        url: attachment.url,
        size: attachment.size,
        contentType: attachment.contentType ?? "application/octet-stream",
        messageUrl: message.url,
        author: message.author.username,
      });
    };
    message.attachments.forEach(add);
    message.messageSnapshots?.forEach((snapshot) =>
      snapshot.attachments.forEach(add),
    );
  }
  return [...attachments.values()];
}

function escapeMarkdown(value: string) {
  return value.replace(/[\r\n]/g, " ").replace(/([\\`*_[\]<>])/g, "\\$1");
}

export async function downloadAttachment(
  attachment: ThreadAttachment,
  limit: number,
): Promise<Buffer> {
  const url = new URL(attachment.url);
  if (
    url.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/attachments/")
  )
    throw new Error("The file is not a Discord attachment URL.");
  if (attachment.size > limit)
    throw new Error(
      `The file exceeds the ${limit / 1024 / 1024} MB upload limit.`,
    );
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Discord download failed (${response.status}).`);
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    throw new Error("The downloaded file exceeds the upload limit.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new Error("The downloaded file exceeds the upload limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

// Uses the same authenticated upload endpoint as GitHub CLI's --attach.
// https://github.com/cli/cli/blob/trunk/internal/attachments/client.go
export class GitHubAttachments {
  private uploaded = new Map<string, string>();
  private pending = new Map<number, Promise<void>>();
  private repositoryId?: number;
  private authorId?: number;

  constructor(
    private github: Octokit,
    private repository: string,
    private download = downloadAttachment,
  ) {}

  sync(
    thread: ThreadChannel,
    issueNumber: number,
    messages: Message[],
  ): Promise<void> {
    const pending = this.pending.get(issueNumber);
    if (pending) return pending;
    const task = this.run(thread, issueNumber, messages).finally(() =>
      this.pending.delete(issueNumber),
    );
    this.pending.set(issueNumber, task);
    return task;
  }

  private async upload(attachment: ThreadAttachment): Promise<string> {
    const cached = this.uploaded.get(attachment.id);
    if (cached) return cached;
    const contentType = mediaTypes[extname(attachment.name).toLowerCase()];
    if (!contentType) return attachment.messageUrl;
    const [owner, repo] = this.repository.split("/");
    if (!this.repositoryId)
      this.repositoryId = (
        await this.github.rest.repos.get({ owner, repo })
      ).data.id;
    const data = await this.download(
      attachment,
      contentType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES,
    );
    const query = new URLSearchParams({
      name: attachment.name,
      content_type: contentType,
      repository_id: String(this.repositoryId),
    });
    const response = await this.github
      .request(
        `POST https://uploads.github.com/user-attachments/assets?${query}`,
        {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(data.length),
          },
          data,
        },
      )
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === "object" &&
          "status" in error &&
          (error.status === 403 || error.status === 404)
        )
          throw new Error(
            "GitHub attachment uploads require a supported user token with write access to the repository.",
          );
        throw error;
      });
    const url = response.data.url as string;
    if (
      !/^https:\/\/github\.com\/user-attachments\/assets\/[\w-]+$/.test(
        url ?? "",
      )
    )
      throw new Error("GitHub did not return a valid attachment URL.");
    this.uploaded.set(attachment.id, url);
    return url;
  }

  private async run(
    thread: ThreadChannel,
    issueNumber: number,
    messages: Message[],
  ) {
    const attachments = collectAttachments(messages);
    if (!attachments.length) return;
    const [owner, repo] = this.repository.split("/");
    const marker = `<!-- pct-bot:attachments:${thread.id} -->`;
    const comments = await this.github.paginate(
      this.github.rest.issues.listComments,
      { owner, repo, issue_number: issueNumber, per_page: 100 },
    );
    if (!this.authorId)
      this.authorId = (await this.github.rest.users.getAuthenticated()).data.id;
    const comment = comments.find(
      (comment) =>
        comment.body?.startsWith(marker) && comment.user?.id === this.authorId,
    );
    let body =
      comment?.body ??
      `${marker}\n## Attachments\n\n[Discord thread](${thread.url})`;
    let commentId = comment?.id;
    const failures: string[] = [];
    for (const attachment of attachments) {
      const entryMarker = `<!-- discord-attachment:${attachment.id} -->`;
      if (body.includes(entryMarker)) continue;
      try {
        const url = await this.upload(attachment);
        const type = mediaTypes[extname(attachment.name).toLowerCase()];
        const link = type?.startsWith("image/")
          ? `![${escapeMarkdown(attachment.name)}](${url})`
          : type?.startsWith("video/")
            ? url
            : `[${escapeMarkdown(attachment.name)} — open in Discord](${url})`;
        const source = type
          ? `[${escapeMarkdown(attachment.author)} · ${escapeMarkdown(attachment.name)}](${attachment.messageUrl})\n\n`
          : "";
        const next = `${body}\n\n${entryMarker}\n${source}${link}`;
        if (next.length > 60_000)
          throw new Error("The attachment comment is full.");
        if (commentId)
          await this.github.rest.issues.updateComment({
            owner,
            repo,
            comment_id: commentId,
            body: next,
          });
        else
          commentId = (
            await this.github.rest.issues.createComment({
              owner,
              repo,
              issue_number: issueNumber,
              body: next,
            })
          ).data.id;
        body = next;
      } catch (error) {
        failures.push(
          `${attachment.name}: ${error instanceof Error ? error.message : "Upload failed"}`,
        );
      }
    }
    if (failures.length)
      throw new Error(
        `Some attachments could not be copied. ${failures.join(" ")}`,
      );
  }
}
