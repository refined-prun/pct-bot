import type { Client, ForumChannel, Message, ThreadChannel } from "discord.js";
import type { Octokit } from "@octokit/rest";
import type { TrackResult } from "../shared/board.js";
import type { GitHubAttachments } from "./attachments.js";

export const TRACKED_IN_REGEX =
  /Tracked in (https:\/\/github\.com\/[^\s]+\/issues\/(\d+))/;

async function readMessages(thread: ThreadChannel): Promise<Message[]> {
  const messages = new Map<string, Message>();
  let before: string | undefined;
  for (;;) {
    const page = await thread.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });
    for (const message of page.values()) messages.set(message.id, message);
    if (page.size < 100) break;
    const next = page.last()?.id;
    if (!next || next === before)
      throw new Error("Could not read the complete thread history.");
    before = next;
  }
  return [...messages.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp,
  );
}

export async function summarizeThread(
  thread: ThreadChannel,
  botId: string | undefined,
  ownerId: string,
) {
  const sortedMessages = await readMessages(thread);

  let content = `Thread ${thread.url}`;
  const references = new Map<string, string>();

  sortedMessages.forEach((msg) => {
    if (msg.type === 4) return;
    if (msg.author.id === botId) return;
    const match = msg.content.match(TRACKED_IN_REGEX);
    if (match) return;
    if (msg.author.id === ownerId && msg.content.startsWith("!")) return;
    content += `\n\n`;
    content += msg.reference?.messageId
      ? `↳<sub>${references.get(msg.reference.messageId)}</sub>\n`
      : ``;
    content += `**${msg.author.username}**`;
    let messageContent = "";
    if (msg.content) {
      messageContent += `\n${msg.content}`;
    }
    msg.attachments.forEach((attachment) => {
      const name = attachment.name
        .replace(/([\\\[\]])/g, "\\$1")
        .replace(/[\r\n]/g, " ");
      messageContent += `\n[${name}](${msg.url})`;
    });
    content += messageContent;
    let reference = messageContent.trim().split("\n")[0];
    if (reference.length > 50) {
      reference = reference.slice(0, 47) + "...";
    }
    references.set(msg.id, reference);
  });

  return content;
}

export class TicketTracker {
  private pending = new Map<string, Promise<TrackResult>>();
  // Remember successful GitHub writes if a later Discord step needs a retry.
  private created = new Map<string, { issueUrl: string; announced: boolean }>();

  constructor(
    private bot: Client,
    private github: Octokit,
    private repository: string,
    private ownerId: string,
    private attachments?: Pick<GitHubAttachments, "sync">,
  ) {}

  async syncAttachments(
    thread: ThreadChannel,
    issueNumber: number,
    messages?: Message[],
  ) {
    await this.attachments?.sync(
      thread,
      issueNumber,
      messages ?? (await readMessages(thread)),
    );
  }

  private async attachmentWarning(
    thread: ThreadChannel,
    issueUrl: string,
    messages: Message[],
  ) {
    try {
      const prefix = `https://github.com/${this.repository}/issues/`;
      if (
        !issueUrl.startsWith(prefix) ||
        !/^\d+$/.test(issueUrl.slice(prefix.length))
      )
        throw new Error(
          "The linked issue is outside the configured GitHub repository.",
        );
      await this.syncAttachments(
        thread,
        Number(issueUrl.slice(prefix.length)),
        messages,
      );
    } catch (error) {
      return `Issue ${issueUrl}: ${error instanceof Error ? error.message : "Attachment upload failed"}`;
    }
  }

  track(thread: ThreadChannel): Promise<TrackResult> {
    const existing = this.pending.get(thread.id);
    if (existing) return existing;
    const task = this.run(thread).finally(() => this.pending.delete(thread.id));
    this.pending.set(thread.id, task);
    return task;
  }

  private async run(thread: ThreadChannel): Promise<TrackResult> {
    const messages = await readMessages(thread);
    const existing = messages
      .find(
        (message) =>
          (message.author.id === this.ownerId ||
            message.author.id === this.bot.user?.id) &&
          TRACKED_IN_REGEX.test(message.content),
      )
      ?.content.match(TRACKED_IN_REGEX)?.[1];
    let created = this.created.get(thread.id);
    if (existing && !created) {
      const warning = await this.attachmentWarning(thread, existing, messages);
      return {
        issueUrl: existing,
        alreadyTracked: true,
        ...(warning ? { warning } : {}),
      };
    }
    const forum = (await thread.parent?.fetch()) as ForumChannel | undefined;
    const tag = forum?.availableTags.find(
      (tag) => tag.name.toLowerCase() === "tracked",
    );
    if (!tag) throw new Error("This forum has no Tracked tag.");
    if (!created) {
      const [owner, repo] = this.repository.split("/");
      if (!owner || !repo)
        throw new Error("GITHUB_REPO must be configured as owner/repository.");
      const issue = await this.github.rest.issues.create({
        owner,
        repo,
        title: thread.name,
        body: await summarizeThread(thread, this.bot.user?.id, this.ownerId),
        labels: [
          "discord",
          forum!.name.toLowerCase().includes("feature") ? "enhancement" : "bug",
        ],
      });
      created = { issueUrl: issue.data.html_url, announced: false };
      this.created.set(thread.id, created);
    }
    const warnings: string[] = [];
    const attachmentWarning = await this.attachmentWarning(
      thread,
      created.issueUrl,
      messages,
    );
    if (attachmentWarning) warnings.push(attachmentWarning);
    const archived = thread.archived;
    try {
      if (archived) await thread.setArchived(false);
      if (!created.announced && !existing) {
        await thread.send(`Tracked in ${created.issueUrl}`);
      }
      created.announced = true;
      await thread.setAppliedTags([tag.id]);
      this.created.delete(thread.id);
    } catch (error) {
      warnings.push(
        `Issue created at ${created.issueUrl}, but Discord could not be updated: ${error instanceof Error ? error.message : "Unknown error"}.`,
      );
    } finally {
      if (archived) {
        try {
          await thread.setArchived(true);
        } catch {
          warnings.push("The post could not be closed again.");
        }
      }
    }
    return {
      issueUrl: created.issueUrl,
      alreadyTracked: false,
      warning: warnings.join(" ") || undefined,
    };
  }
}
