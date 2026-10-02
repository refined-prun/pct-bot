import type {
  APIMessage,
  APIThreadChannel,
  APIGuildForumChannel,
} from "discord.js";

export type BoardKey = "bugs" | "features";
export type ForumTag = NonNullable<
  APIGuildForumChannel["available_tags"]
>[number];
export type DiscordThread = APIThreadChannel;
export interface Ticket {
  id: string;
  title: string;
  tags: string[];
  updatedAt: string;
  comments: number;
  archived: boolean;
  locked: boolean;
  url: string;
}
export interface Board {
  key: BoardKey;
  name: string;
  channelId: string;
  tags: ForumTag[];
  tickets: Ticket[];
  fetchedAt: string;
}
export interface TicketDetails {
  ticket: Ticket;
  starter: APIMessage | null;
  messages: APIMessage[];
}
export interface TrackResult {
  issueUrl: string;
  alreadyTracked: boolean;
  warning?: string;
}
