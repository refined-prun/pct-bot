import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Collection,
  type Client,
  type Message,
  type ThreadChannel,
} from "discord.js";
import type { Octokit } from "@octokit/rest";
import { TicketTracker } from "../server/tracking.js";

const issueUrl = "https://github.com/example/repo/issues/123";
function fixture(
  options: {
    archived?: boolean;
    missingTag?: boolean;
    name?: string;
    syncAttachments?: (
      thread: ThreadChannel,
      issue: number,
      messages: Message[],
    ) => Promise<void>;
  } = {},
) {
  const messages: Message[] = [];
  const writes: string[] = [];
  const issues: Record<string, unknown>[] = [];
  let failSend = false;
  let failTags = false;
  let failCreate = false;
  const thread = {
    id: "123",
    name: "Ticket title",
    url: "https://discord.com/channels/1/123",
    archived: !!options.archived,
    parent: {
      fetch: async () => ({
        name: options.name ?? "features",
        availableTags: options.missingTag
          ? []
          : [{ id: "tracked", name: "Tracked" }],
      }),
    },
    messages: {
      fetch: async ({ before }: { before?: string }) => {
        const sorted = [...messages].reverse();
        const start = before
          ? sorted.findIndex((message) => message.id === before) + 1
          : 0;
        return new Collection(
          sorted
            .slice(start, start + 100)
            .map((message) => [message.id, message]),
        );
      },
    },
    send: async (content: string) => {
      if (failSend) throw new Error("Send failed");
      writes.push(content);
      addMessage(content, "bot");
    },
    setAppliedTags: async (tags: string[]) => {
      if (failTags) throw new Error("Tag failed");
      writes.push(`tags:${tags.join(",")}`);
    },
    setArchived: async (value: boolean) => {
      writes.push(`archived:${value}`);
    },
  } as unknown as ThreadChannel;
  const github = {
    rest: {
      issues: {
        create: async (issue: Record<string, unknown>) => {
          if (failCreate) throw new Error("GitHub failed");
          issues.push(issue);
          return { data: { html_url: issueUrl } };
        },
      },
    },
  } as unknown as Octokit;
  const tracker = new TicketTracker(
    { user: { id: "bot" } } as Client,
    github,
    "example/repo",
    "owner",
    options.syncAttachments ? { sync: options.syncAttachments } : undefined,
  );
  function addMessage(content: string, author = "person") {
    messages.push({
      id: `${messages.length + 1}`,
      createdTimestamp: messages.length,
      content,
      author: { id: author, username: author },
      attachments: new Collection(),
      type: 0,
    } as Message);
  }
  return {
    tracker,
    thread,
    writes,
    issues,
    addMessage,
    failSend: (value: boolean) => {
      failSend = value;
    },
    failTags: (value: boolean) => {
      failTags = value;
    },
    failCreate: () => {
      failCreate = true;
    },
  };
}
test("tracking creates one labeled issue, summarizes all messages and updates Discord", async () => {
  const f = fixture({ archived: true });
  f.addMessage("Original description");
  for (let i = 0; i < 105; i++) f.addMessage(`Comment ${i}`);
  f.addMessage("!track", "owner");
  const [a, b] = await Promise.all([
    f.tracker.track(f.thread),
    f.tracker.track(f.thread),
  ]);
  assert.equal(a.issueUrl, issueUrl);
  assert.deepEqual(a, b);
  assert.equal(f.issues.length, 1);
  assert.deepEqual(f.issues[0].labels, ["discord", "enhancement"]);
  assert.equal(f.issues[0].title, "Ticket title");
  assert.match(String(f.issues[0].body), /Original description/);
  assert.match(String(f.issues[0].body), /Comment 104/);
  assert.doesNotMatch(String(f.issues[0].body), /!track/);
  assert.deepEqual(f.writes, [
    "archived:false",
    `Tracked in ${issueUrl}`,
    "tags:tracked",
    "archived:true",
  ]);
  assert.equal((await f.tracker.track(f.thread)).alreadyTracked, true);
  assert.equal(f.issues.length, 1);
});
test("existing issue markers older than 100 comments prevent duplicate issues", async () => {
  const f = fixture();
  f.addMessage(`Tracked in ${issueUrl}`, "owner");
  for (let i = 0; i < 101; i++) f.addMessage(`Comment ${i}`);
  assert.deepEqual(await f.tracker.track(f.thread), {
    issueUrl,
    alreadyTracked: true,
  });
  assert.equal(f.issues.length, 0);
  assert.equal(f.writes.length, 0);
});
test("missing Tracked tag fails before creating an issue", async () => {
  const f = fixture({ missingTag: true });
  await assert.rejects(f.tracker.track(f.thread), /no Tracked tag/);
  assert.equal(f.issues.length, 0);
});
test("GitHub failure does not post a link or change tags", async () => {
  const f = fixture();
  f.failCreate();
  await assert.rejects(f.tracker.track(f.thread), /GitHub failed/);
  assert.equal(f.writes.length, 0);
});
test("announcement failure reports the issue URL and retry reuses the created issue", async () => {
  const f = fixture({ archived: true, name: "bugs" });
  f.failSend(true);
  const result = await f.tracker.track(f.thread);
  assert.match(result.warning!, /Send failed/);
  assert.equal(result.issueUrl, issueUrl);
  assert.deepEqual(f.writes, ["archived:false", "archived:true"]);
  f.failSend(false);
  assert.equal((await f.tracker.track(f.thread)).warning, undefined);
  assert.equal(f.issues.length, 1);
  assert.deepEqual(f.issues[0].labels, ["discord", "bug"]);
});
test("tag failure retries without a second issue or announcement", async () => {
  const f = fixture();
  f.failTags(true);
  assert.match((await f.tracker.track(f.thread)).warning!, /Tag failed/);
  f.failTags(false);
  await f.tracker.track(f.thread);
  assert.equal(f.issues.length, 1);
  assert.deepEqual(f.writes, [`Tracked in ${issueUrl}`, "tags:tracked"]);
});

test("tracking syncs attachments and retries an upload failure without duplicating the issue", async () => {
  let calls = 0;
  const f = fixture({
    syncAttachments: async (_thread, issue, messages) => {
      assert.equal(issue, 123);
      assert.ok(
        messages.some((message) => message.content === "Original message"),
      );
      if (++calls === 1) throw new Error("Attachment upload failed");
    },
  });
  f.addMessage("Original message");
  assert.match(
    (await f.tracker.track(f.thread)).warning!,
    /Attachment upload failed/,
  );
  const retry = await f.tracker.track(f.thread);
  assert.equal(retry.alreadyTracked, true);
  assert.equal(retry.warning, undefined);
  assert.equal(calls, 2);
  assert.equal(f.issues.length, 1);
  assert.deepEqual(f.writes, [`Tracked in ${issueUrl}`, "tags:tracked"]);
});
