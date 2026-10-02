import {
  ChannelType,
  type Client,
  type APIMessage,
  type APIGuildForumChannel,
} from "discord.js";
import type {
  Board,
  BoardKey,
  DiscordThread,
  Ticket,
  TicketDetails,
  TrackResult,
} from "../shared/board.js";
import { moveTags } from "./move.js";

export const GUILD_ID = "667551433503014924";
export const FORUMS = {
  bugs: { id: "1310995683066642483", label: "Bug reports" },
  features: { id: "1310995731640877161", label: "Feature requests" },
} as const;

export function ticketFromThread(thread: DiscordThread): Ticket {
  const timestamp =
    Number(BigInt(thread.last_message_id ?? thread.id) >> 22n) + 1420070400000;
  return {
    id: thread.id,
    title: thread.name,
    tags: thread.applied_tags ?? [],
    updatedAt: new Date(timestamp).toISOString(),
    comments: thread.message_count ?? 0,
    archived: thread.thread_metadata?.archived ?? false,
    locked: thread.thread_metadata?.locked ?? false,
    url: `https://discord.com/channels/${GUILD_ID}/${thread.id}`,
  };
}

export class DiscordBoard {
  private cache = new Map<BoardKey, { expires: number; value: Board }>();
  private pending = new Map<BoardKey, Promise<Board>>();
  private moving = new Set<string>();

  constructor(
    private client: Client,
    private trackThread?: (id: string) => Promise<TrackResult>,
  ) {}

  async forum(key: BoardKey) {
    const channel = (await this.client.rest.get(
      `/channels/${FORUMS[key].id}`,
    )) as APIGuildForumChannel;
    if (
      channel.type !== ChannelType.GuildForum ||
      channel.guild_id !== GUILD_ID
    ) {
      throw new Error(
        "The configured channel is not a forum in the expected server.",
      );
    }
    return channel;
  }

  async thread(key: BoardKey, id: string) {
    if (!/^\d{17,20}$/.test(id)) throw new Error("Invalid ticket ID.");
    const thread = (await this.client.rest.get(
      `/channels/${id}`,
    )) as DiscordThread;
    if (
      thread.parent_id !== FORUMS[key].id ||
      thread.guild_id !== GUILD_ID ||
      thread.type !== ChannelType.PublicThread
    ) {
      throw new Error("This ticket does not belong to this board.");
    }
    return thread;
  }

  async board(key: BoardKey, refresh = false): Promise<Board> {
    const cached = this.cache.get(key);
    if (!refresh && cached && cached.expires > Date.now()) return cached.value;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.loadBoard(key).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private async loadBoard(key: BoardKey): Promise<Board> {
    const [forum, active] = await Promise.all([
      this.forum(key),
      this.client.rest.get(`/guilds/${GUILD_ID}/threads/active`) as Promise<{
        threads: DiscordThread[];
      }>,
    ]);
    const threads = new Map<string, DiscordThread>();
    let before: string | undefined;
    for (;;) {
      const query = new URLSearchParams({
        limit: "100",
        ...(before ? { before } : {}),
      });
      const page = (await this.client.rest.get(
        `/channels/${forum.id}/threads/archived/public`,
        { query },
      )) as {
        threads: DiscordThread[];
        has_more: boolean;
      };
      for (const thread of page.threads) threads.set(thread.id, thread);
      if (!page.has_more) break;
      const next = page.threads.at(-1)?.thread_metadata?.archive_timestamp;
      if (!next || next === before)
        throw new Error(
          "Discord returned an incomplete page of older posts. Please retry.",
        );
      before = next;
    }
    for (const thread of active.threads) {
      if (thread.parent_id === forum.id) threads.set(thread.id, thread);
    }
    const value: Board = {
      key,
      name: forum.name,
      channelId: forum.id,
      tags: forum.available_tags ?? [],
      tickets: [...threads.values()]
        .map(ticketFromThread)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      fetchedAt: new Date().toISOString(),
    };
    this.cache.set(key, { expires: Date.now() + 15_000, value });
    return value;
  }

  async details(key: BoardKey, id: string): Promise<TicketDetails> {
    const thread = await this.thread(key, id);
    const messages = new Map<string, APIMessage>();
    let before: string | undefined;
    for (;;) {
      const query = new URLSearchParams({
        limit: "100",
        ...(before ? { before } : {}),
      });
      const page = (await this.client.rest.get(`/channels/${id}/messages`, {
        query,
      })) as APIMessage[];
      for (const message of page) messages.set(message.id, message);
      if (page.length < 100) break;
      const next = page.at(-1)?.id;
      if (!next || next === before)
        throw new Error(
          "Discord returned an incomplete message history. Please retry.",
        );
      before = next;
    }
    const sorted = [...messages.values()].sort((a, b) =>
      a.id === b.id ? 0 : BigInt(a.id) < BigInt(b.id) ? -1 : 1,
    );
    for (const message of sorted) {
      const ref = message.message_reference;
      if (
        ref?.message_id &&
        !message.referenced_message &&
        ref.type !== 1 &&
        messages.has(ref.message_id)
      ) {
        // Do not construct circular reply chains in the JSON response.
        const { referenced_message: _reply, ...quoted } = messages.get(
          ref.message_id,
        )!;
        message.referenced_message = quoted;
      }
    }
    return {
      ticket: ticketFromThread(thread),
      starter: messages.get(id) ?? null,
      messages: sorted.filter((msg) => msg.id !== id),
    };
  }

  private async mutate<T>(key: BoardKey, id: string, action: () => Promise<T>) {
    if (this.moving.has(id))
      throw new Error("An update is already in progress for this ticket.");
    this.moving.add(id);
    try {
      return await action();
    } finally {
      this.cache.delete(key);
      this.moving.delete(id);
    }
  }

  async rename(key: BoardKey, id: string, title: string) {
    const name = title.trim();
    if (!name || name.length > 100)
      throw new Error("The title must contain 1–100 characters.");
    return this.mutate(key, id, async () => {
      const original = await this.thread(key, id);
      if (original.name === name) return { ticket: ticketFromThread(original) };
      const archived = original.thread_metadata?.archived ?? false;
      let warning: string | undefined;
      try {
        await this.client.rest.patch(`/channels/${id}`, {
          body: { name, ...(archived ? { archived: false } : {}) },
          reason: "Renamed on the local Refined PrUn board",
        });
      } finally {
        if (archived) {
          try {
            await this.client.rest.patch(`/channels/${id}`, {
              body: { archived: true },
            });
          } catch {
            warning = "The post could not be closed again.";
          }
        }
      }
      return { ticket: ticketFromThread(await this.thread(key, id)), warning };
    });
  }

  async track(key: BoardKey, id: string) {
    return this.mutate(key, id, async () => {
      await this.thread(key, id);
      if (!this.trackThread)
        throw new Error("GitHub tracking is not configured.");
      const result = await this.trackThread(id);
      return {
        ...result,
        ticket: ticketFromThread(await this.thread(key, id)),
      };
    });
  }

  async move(key: BoardKey, id: string, source: string, destination: string) {
    return this.mutate(key, id, async () => {
      const forum = await this.forum(key);
      if (
        ![source, destination].every((tag) =>
          forum.available_tags?.some((candidate) => candidate.id === tag),
        )
      ) {
        throw new Error(
          "These tags are no longer available. Refresh the board.",
        );
      }
      const result = await moveTags(
        {
          read: async () => {
            const thread = await this.thread(key, id);
            return {
              tags: thread.applied_tags ?? [],
              archived: thread.thread_metadata?.archived ?? false,
            };
          },
          write: (change) =>
            this.client.rest.patch(`/channels/${id}`, {
              body: {
                ...(change.tags ? { applied_tags: change.tags } : {}),
                ...(change.archived !== undefined
                  ? { archived: change.archived }
                  : {}),
              },
              reason: "Moved on the local Refined PrUn board",
            }),
        },
        source,
        destination,
      );
      return {
        ...result,
        ticket: ticketFromThread(await this.thread(key, id)),
      };
    });
  }
}
