import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "discord.js";
import {
  DiscordBoard,
  FORUMS,
  GUILD_ID,
  ticketFromThread,
} from "../server/discord-board.js";
import type { DiscordThread } from "../shared/board.js";

const id = "1555374930600923226";
const thread = (overrides = {}) =>
  ({
    id,
    type: 11,
    name: "Test ticket",
    guild_id: GUILD_ID,
    parent_id: FORUMS.features.id,
    applied_tags: ["open"],
    message_count: 204,
    last_message_id: "1556374930600923226",
    thread_metadata: {
      archived: false,
      archive_timestamp: "2026-10-01T00:00:00.000Z",
      locked: false,
      auto_archive_duration: 1440,
    },
    ...overrides,
  }) as DiscordThread;
function service(
  get: (
    path: string,
    options?: { query?: URLSearchParams },
  ) => Promise<unknown>,
) {
  return new DiscordBoard({ rest: { get } } as unknown as Client);
}
test("lists all archived pages, filters other forums, deduplicates and sorts by last message", async () => {
  let pages = 0;
  const bot = service(async (path, options) => {
    if (path === `/channels/${FORUMS.features.id}`)
      return {
        id: FORUMS.features.id,
        type: 15,
        guild_id: GUILD_ID,
        name: "features",
        available_tags: [{ id: "open", name: "Open" }],
      };
    if (path.endsWith("/active"))
      return {
        threads: [
          thread(),
          thread({ id: "1557374930600923226", parent_id: FORUMS.bugs.id }),
        ],
      };
    if (path.endsWith("/archived/public")) {
      pages++;
      if (pages === 1)
        return {
          threads: [
            thread({ archived: true }),
            thread({
              id: "1554374930600923226",
              last_message_id: "1554374930600923226",
            }),
          ],
          has_more: true,
        };
      assert.equal(options?.query?.get("before"), "2026-10-01T00:00:00.000Z");
      return {
        threads: [
          thread({
            id: "1553374930600923226",
            last_message_id: "1553374930600923226",
          }),
        ],
        has_more: false,
      };
    }
    throw new Error(path);
  });
  const board = await bot.board("features");
  assert.equal(pages, 2);
  assert.equal(board.tickets.length, 3);
  assert.equal(board.tickets[0].id, id);
  assert.equal(board.tickets[0].archived, false);
  await bot.board("features");
  assert.equal(pages, 2, "short cache avoids refetching all older posts");
});
test("loads over 100 messages, separates starter, preserves attachments and forward snapshots", async () => {
  const messages = Array.from({ length: 205 }, (_, i) => ({
    id: (BigInt(id) + BigInt(i)).toString(),
    content: `Message ${i}`,
    author: { id: "1", username: "Test" },
    attachments:
      i === 2
        ? [
            {
              id: "image",
              filename: "screen.png",
              url: "https://cdn.discordapp.com/screen.png",
            },
          ]
        : [],
    ...(i === 3
      ? {
          message_snapshots: [
            { message: { content: "Forwarded", attachments: [], embeds: [] } },
          ],
          message_reference: { type: 1, message_id: "1" },
        }
      : {}),
    ...(i === 4
      ? { message_reference: { message_id: (BigInt(id) + 2n).toString() } }
      : {}),
  })).reverse();
  let pages = 0;
  const bot = service(async (path, options) => {
    if (path === `/channels/${id}`) return thread();
    pages++;
    const before = options?.query?.get("before");
    const start = before
      ? messages.findIndex((message) => message.id === before) + 1
      : 0;
    return messages.slice(start, start + 100);
  });
  const detail = await bot.details("features", id);
  assert.equal(pages, 3);
  assert.equal(detail.starter?.id, id);
  assert.equal(detail.messages.length, 204);
  assert.equal(detail.messages[1].attachments[0].filename, "screen.png");
  assert.equal(
    detail.messages[2].message_snapshots?.[0].message.content,
    "Forwarded",
  );
  assert.equal(detail.messages[3].referenced_message?.content, "Message 2");
  assert.doesNotThrow(() => JSON.stringify(detail));
});
test("rejects access to a ticket outside the selected forum", async () => {
  const bot = service(async () => thread({ parent_id: "other" }));
  await assert.rejects(bot.details("features", id), /does not belong/);
});
test("activity timestamps come from the last message rather than archive timestamps", () => {
  const ticket = ticketFromThread(thread());
  assert.equal(
    Date.parse(ticket.updatedAt),
    Number(BigInt("1556374930600923226") >> 22n) + 1420070400000,
  );
});

test("rename trims titles, preserves tags and lock state, and restores archived posts", async () => {
  const state = thread();
  state.thread_metadata!.archived = true;
  state.thread_metadata!.locked = true;
  const writes: Record<string, unknown>[] = [];
  const bot = new DiscordBoard({
    rest: {
      get: async () => state,
      patch: async (
        _path: string,
        { body }: { body: Record<string, unknown> },
      ) => {
        writes.push(body);
        if (body.name) state.name = body.name as string;
        if (body.archived !== undefined)
          state.thread_metadata!.archived = body.archived as boolean;
      },
    },
  } as unknown as Client);
  const result = await bot.rename("features", id, "  New title  ");
  assert.equal(result.ticket.title, "New title");
  assert.equal(result.ticket.archived, true);
  assert.equal(result.ticket.locked, true);
  assert.deepEqual(result.ticket.tags, ["open"]);
  assert.deepEqual(writes, [
    { name: "New title", archived: false },
    { archived: true },
  ]);
  await assert.rejects(bot.rename("features", id, "  "), /1–100/);
  await assert.rejects(bot.rename("features", id, "a".repeat(101)), /1–100/);
  assert.equal(writes.length, 2);
});
test("rename and tracking reject tickets from another forum before writing", async () => {
  let writes = 0;
  const bot = new DiscordBoard(
    {
      rest: {
        get: async () => thread({ parent_id: "other" }),
        patch: async () => {
          writes++;
        },
      },
    } as unknown as Client,
    async () => {
      writes++;
      return {
        issueUrl: "https://github.com/example/repo/issues/1",
        alreadyTracked: false,
      };
    },
  );
  await assert.rejects(
    bot.rename("features", id, "New title"),
    /does not belong/,
  );
  await assert.rejects(bot.track("features", id), /does not belong/);
  assert.equal(writes, 0);
});
test("tracking blocks concurrent title changes until it finishes", async () => {
  let finish!: () => void;
  let started!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const bot = new DiscordBoard(
    { rest: { get: async () => thread() } } as unknown as Client,
    async () => {
      started();
      await wait;
      return {
        issueUrl: "https://github.com/example/repo/issues/1",
        alreadyTracked: false,
      };
    },
  );
  const tracking = bot.track("features", id);
  await ready;
  await assert.rejects(
    bot.rename("features", id, "New title"),
    /already in progress/,
  );
  finish();
  assert.equal((await tracking).ticket.id, id);
});
