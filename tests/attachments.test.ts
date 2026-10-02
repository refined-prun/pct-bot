import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Collection,
  type Message,
  type Attachment,
  type ThreadChannel,
} from "discord.js";
import { Octokit } from "@octokit/rest";
import {
  GitHubAttachments,
  collectAttachments,
  downloadAttachment,
  type ThreadAttachment,
} from "../server/attachments.js";

const thread = {
  id: "123",
  url: "https://discord.com/channels/1/123",
} as ThreadChannel;
const asset = (id = "1", name = "image.png") =>
  ({
    id,
    name,
    url: `https://cdn.discordapp.com/attachments/123/${id}/${name}`,
    size: 3,
    contentType: "image/png",
  }) as Attachment;
function message(
  attachments: Attachment[],
  snapshots: Attachment[] = [],
): Message {
  return {
    url: "https://discord.com/channels/1/123/456",
    author: { username: "Alice" },
    attachments: new Collection(attachments.map((a) => [a.id, a])),
    messageSnapshots: new Collection([
      [
        "forward",
        { attachments: new Collection(snapshots.map((a) => [a.id, a])) },
      ],
    ]),
  } as unknown as Message;
}
function fixture() {
  const comments: { id: number; body: string; user: { id: number } }[] = [];
  const uploads: { route: string; data: Buffer }[] = [];
  let failUpload = "";
  let failComment = false;
  const github = {
    paginate: async () => comments,
    rest: {
      users: { getAuthenticated: async () => ({ data: { id: 10 } }) },
      repos: { get: async () => ({ data: { id: 1234 } }) },
      issues: {
        listComments: () => {},
        createComment: async ({ body }: { body: string }) => {
          if (failComment) throw new Error("Comment failed");
          const comment = { id: comments.length + 1, body, user: { id: 10 } };
          comments.push(comment);
          return { data: comment };
        },
        updateComment: async ({
          comment_id,
          body,
        }: {
          comment_id: number;
          body: string;
        }) => {
          if (failComment) throw new Error("Comment failed");
          comments.find((c) => c.id === comment_id)!.body = body;
        },
      },
    },
    request: async (route: string, { data }: { data: Buffer }) => {
      if (route.includes(failUpload) && failUpload)
        throw new Error("Upload failed");
      uploads.push({ route, data });
      return {
        data: {
          url: `https://github.com/user-attachments/assets/asset-${uploads.length}`,
        },
      };
    },
  } as unknown as Octokit;
  const download = async () => Buffer.from("abc");
  return {
    github,
    comments,
    uploads,
    download,
    manager: new GitHubAttachments(github, "example/repo", download),
    failUpload: (name: string) => {
      failUpload = name;
    },
    failComment: (value: boolean) => {
      failComment = value;
    },
  };
}
test("collects normal and forwarded attachments once, including attachment-only messages", () => {
  const files = collectAttachments([message([asset()], [asset(), asset("2")])]);
  assert.deepEqual(
    files.map((f) => f.id),
    ["1", "2"],
  );
  assert.equal(files[1].author, "Alice");
});
test("uploads image and video bytes and adds a separate attachment comment", async () => {
  const f = fixture();
  await f.manager.sync(thread, 99, [
    message([asset(), asset("2", "clip.mp4")]),
  ]);
  assert.equal(f.uploads.length, 2);
  assert.match(f.uploads[0].route, /repository_id=1234/);
  assert.match(f.uploads[0].route, /content_type=image%2Fpng/);
  assert.equal(f.uploads[0].data.toString(), "abc");
  assert.equal(f.comments.length, 1);
  assert.match(
    f.comments[0].body,
    /!\[image.png\]\(https:\/\/github.com\/user-attachments\/assets\/asset-1\)/,
  );
  assert.match(
    f.comments[0].body,
    /\n\nhttps:\/\/github.com\/user-attachments\/assets\/asset-2/,
  );
  assert.doesNotMatch(f.comments[0].body, /cdn.discordapp.com/);
});
test("a new manager resumes from the comment without reuploading old attachments", async () => {
  const f = fixture();
  await f.manager.sync(thread, 99, [message([asset()])]);
  const next = new GitHubAttachments(f.github, "example/repo", f.download);
  await next.sync(thread, 99, [message([asset(), asset("2")])]);
  assert.equal(f.uploads.length, 2);
  assert.equal(f.comments.length, 1);
});
test("partial failures preserve uploaded attachments and retry only missing ones", async () => {
  const f = fixture();
  f.failUpload("bad.png");
  const messages = [message([asset(), asset("2", "bad.png")])];
  await assert.rejects(
    f.manager.sync(thread, 99, messages),
    /bad.png: Upload failed/,
  );
  assert.equal(f.comments.length, 1);
  f.failUpload("");
  await f.manager.sync(thread, 99, messages);
  assert.equal(f.uploads.length, 2);
  assert.equal(
    (f.comments[0].body.match(/discord-attachment:/g) ?? []).length,
    2,
  );
});
test("comment failures retain the uploaded URL for retry", async () => {
  const f = fixture();
  f.failComment(true);
  await assert.rejects(
    f.manager.sync(thread, 99, [message([asset()])]),
    /Comment failed/,
  );
  f.failComment(false);
  await f.manager.sync(thread, 99, [message([asset()])]);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.comments.length, 1);
});
test("escapes Markdown in attachment names", async () => {
  const f = fixture();
  await f.manager.sync(thread, 99, [message([asset("1", "a[link].png")])]);
  assert.match(f.comments[0].body, /!\[a\\\[link\\\].png\]/);
});
test("download rejects non-Discord URLs and oversized files before fetching", async () => {
  const attachment = {
    ...asset(),
    messageUrl: thread.url,
    author: "Alice",
  } as ThreadAttachment;
  for (const url of [
    "http://127.0.0.1/",
    "https://attacker.example/file.png",
    "https://cdn.discordapp.com@attacker.example/attachments/x",
    "https://cdn.discordapp.com/not-attachments/x",
  ]) {
    await assert.rejects(
      downloadAttachment({ ...attachment, url }, 10),
      /not a Discord attachment/,
    );
  }
  await assert.rejects(
    downloadAttachment({ ...attachment, size: 11 }, 10),
    /exceeds/,
  );
});

test("JSON and ZIP files link to the original Discord message without uploading", async () => {
  const f = fixture();
  await f.manager.sync(thread, 99, [
    message([asset("1", "log.json"), asset("2", "report.zip")]),
  ]);
  assert.equal(f.uploads.length, 0);
  assert.match(
    f.comments[0].body,
    /\[log.json — open in Discord\]\(https:\/\/discord.com\/channels\/1\/123\/456\)/,
  );
  assert.match(f.comments[0].body, /report.zip — open in Discord/);
  assert.doesNotMatch(f.comments[0].body, /cdn.discordapp.com/);
});
test("does not edit another author's comment with a matching marker", async () => {
  const f = fixture();
  f.comments.push({
    id: 1,
    body: "<!-- pct-bot:attachments:123 -->\nSomeone else",
    user: { id: 20 },
  });
  await f.manager.sync(thread, 99, [message([asset()])]);
  assert.equal(f.comments.length, 2);
  assert.equal(
    f.comments[0].body,
    "<!-- pct-bot:attachments:123 -->\nSomeone else",
  );
});

test("Octokit sends binary data to the GitHub upload endpoint with repository metadata", async () => {
  let uploaded = false;
  const github = new Octokit({
    auth: "test-token",
    request: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        let result: unknown;
        if (url.hostname === "uploads.github.com") {
          assert.equal(url.pathname, "/user-attachments/assets");
          assert.equal(url.searchParams.get("repository_id"), "1234");
          assert.equal(url.searchParams.get("name"), "image.png");
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "token test-token",
          );
          assert.ok(Buffer.isBuffer(init?.body));
          assert.equal(init.body.toString(), "abc");
          uploaded = true;
          result = {
            url: "https://github.com/user-attachments/assets/test-upload",
          };
        } else if (url.pathname === "/user") result = { id: 10 };
        else if (url.pathname === "/repos/example/repo") result = { id: 1234 };
        else if (url.pathname.endsWith("/comments") && init?.method === "GET")
          result = [];
        else if (url.pathname.endsWith("/comments") && init?.method === "POST")
          result = { id: 1 };
        else throw new Error(`Unexpected request: ${url.pathname}`);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  await new GitHubAttachments(github, "example/repo", async () =>
    Buffer.from("abc"),
  ).sync(thread, 99, [message([asset()])]);
  assert.equal(uploaded, true);
});
test("download limits are enforced while streaming, even without a length header", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(new Uint8Array(20), { status: 200 }),
  );
  const attachment = {
    ...asset(),
    messageUrl: thread.url,
    author: "Alice",
  } as ThreadAttachment;
  await assert.rejects(downloadAttachment(attachment, 10), /exceeds/);
});
