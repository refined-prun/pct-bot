# Refined PrUn ticket bot

Discord/GitHub integration and a local Vue board for Refined PrUn's bug reports and feature requests.

## Run locally

Use Node.js 22.12+ (or a newer supported LTS) and pnpm. Install with `pnpm install`, then copy `.env.example` to `.env` if you do not already have the bot's configuration. Keep the existing Discord and GitHub credentials in `.env`.

```sh
pnpm dev
```

Open **http://localhost:5173**. This starts both the bot and Vite, with frontend hot reload and backend restart on source changes. `pnpm start` also serves the board, without watching backend source files. Run only one instance for a given bot token, to avoid processing Discord commands twice. Set `BOARD_PORT` in `.env` to use another port.

For the built UI, stop the development process, then run:

```sh
pnpm build
pnpm start:production
```

The server listens only on `127.0.0.1`. The bot token stays on the server; host/origin checks and a per-process request token protect ticket changes from other websites. There is no public hosting or account login.

## Board behavior

- Switch between **Bug reports** and **Feature requests**. Columns use each forum's current tags, in Discord's order.
- All accessible active and archived posts are included. Each column sorts by its latest message's timestamp, derived from Discord's `last_message_id` (or creation time when unavailable). Edits, tag changes, and archive times do not bump a ticket.
- Drag a card into a column to add that tag, then remove the source column's tag. Unrelated tags remain intact; a ticket with multiple tags appears in every matching column. No Untagged column is created. Unexpected untagged posts produce a visible warning.
- Open a ticket to read the starter post and complete paginated comment history, including images, download links, embeds, reactions, replies, and forwarded snapshots. Missing/deleted references link back to Discord when possible. The sidebar's **Move to** menu provides a keyboard/touch alternative to dragging.
- Use **Edit title** in the ticket sidebar to rename a Discord thread (1–100 characters). **Track on GitHub** runs the same operation as `!track`: create a labeled issue from the thread, post its link, and replace the tags with **Tracked**. Existing issue links are detected across the complete message history. Comments remain read-only apart from the tracking link posted by the bot.
- Tracking adds a separate **Attachments** comment: supported images/videos are uploaded to GitHub, while other files link to their original Discord messages (Discord access required). Forwarded attachments are included. `!update` and repeat tracking sync missing attachments into that comment without duplicating entries. Upload failures are reported while keeping the created issue and successful attachments. Media uploads use the same endpoint as [GitHub CLI attachment uploads](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli) and require a supported user token with repository write access; images are limited to 10 MB and videos to 100 MB (GitHub may apply a lower plan limit).
- Older posts are temporarily reopened for a move and closed again afterward, preserving their lock flag. If adding fails, the original tag is retained. If removing fails, both tags remain and retry can finish the move. Any failure to restore the closed state is reported.
- Moves for the same ticket are serialized by rejecting a second in-flight move. The service reads tags again between writes to preserve unrelated Discord changes. Discord has no conditional/atomic tag update, so a simultaneous external edit during a PATCH can still race; the final state is fetched from Discord.
- Boards refresh every 30 seconds while visible. Use **Refresh** in the ticket sidebar for newer comments and refreshed attachment URLs. Comments are read-only; **Open in Discord** opens the conversation.
- Press `/` to search titles or ticket IDs; press Escape to close a ticket.

The forum IDs are configured in `server/discord-board.ts`. The bot needs **View Channel**, **Read Message History**, and **Manage Threads** in both forums. **Message Content Intent** must be enabled for the application (also used by the existing commands). Keep any existing permissions needed for `!track` and `!update`.

## Checks

```sh
pnpm typecheck
pnpm test
pnpm build
```

Tests exercise pagination beyond 100 comments, archived thread pagination, board isolation, tag ordering/preservation, partial failures, retries, archive restoration, and local API security.
