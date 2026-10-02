import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "discord.js";
import { DiscordBoard, FORUMS } from "./discord-board.js";
import type { BoardKey, TrackResult } from "../shared/board.js";

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

export async function startBoardServer(
  client: Client,
  trackThread?: (id: string) => Promise<TrackResult>,
) {
  const port = Number(process.env.BOARD_PORT ?? 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("BOARD_PORT must be a valid port.");
  const service = new DiscordBoard(client, trackThread);
  const token = randomBytes(32).toString("hex");
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const production = process.env.NODE_ENV === "production";
  const root = fileURLToPath(new URL("../dist/web", import.meta.url));
  const server = createServer();
  const vite = production
    ? null
    : await (
        await import("vite")
      ).createServer({
        // Keep test/preview servers from replacing a running board's dependencies.
        cacheDir: fileURLToPath(
          new URL(`../node_modules/.vite/board-${port}`, import.meta.url),
        ),
        configFile: fileURLToPath(
          new URL("../vite.config.ts", import.meta.url),
        ),
        server: {
          middlewareMode: true,
          hmr: { server },
          allowedHosts: ["localhost", "127.0.0.1"],
        },
      });
  server.on("request", (request, response) => {
    void handle(request, response).catch((error) => {
      console.error(
        "Board request failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      if (!response.headersSent)
        json(response, 502, {
          error:
            error instanceof Error ? error.message : "Discord request failed.",
        });
      else response.end();
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (!hosts.has(request.headers.host ?? ""))
      return json(response, 403, { error: "Local access only." });
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const origin = request.headers.origin;
    // Opening the board from an external link is a cross-site navigation.
    // Only the document entry points are safe to allow; API requests stay guarded.
    const boardNavigation =
      (request.method === "GET" || request.method === "HEAD") &&
      (url.pathname === "/" || url.pathname === "/index.html") &&
      request.headers["sec-fetch-mode"] === "navigate" &&
      request.headers["sec-fetch-dest"] === "document";
    if (
      (origin && origin !== `http://${request.headers.host}`) ||
      (request.headers["sec-fetch-site"] === "cross-site" && !boardNavigation)
    ) {
      return json(response, 403, {
        error: "Cross-origin requests are not allowed.",
      });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!client.isReady())
        return json(response, 503, {
          error: "The bot is connecting to Discord. Try again shortly.",
        });
      if (url.pathname === "/api/session" && request.method === "GET") {
        return json(response, 200, {
          token,
          boards: FORUMS,
          bot: client.user?.username,
        });
      }
      const match = url.pathname.match(
        /^\/api\/boards\/(bugs|features)(?:\/tickets\/(\d{17,20})(\/move|\/title|\/track)?)?$/,
      );
      if (!match) return json(response, 404, { error: "Not found." });
      const key = match[1] as BoardKey;
      if (request.method === "GET" && !match[3]) {
        return json(
          response,
          200,
          match[2]
            ? await service.details(key, match[2])
            : await service.board(key, url.searchParams.has("refresh")),
        );
      }
      if (request.method === "POST" && match[2] && match[3]) {
        if (
          request.headers["x-board-token"] !== token ||
          request.headers["content-type"] !== "application/json"
        ) {
          return json(response, 403, {
            error: "Reload the board before updating a ticket.",
          });
        }
        let body;
        try {
          body = await readBody(request);
        } catch {
          return json(response, 400, { error: "Invalid request body." });
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          return json(response, 400, { error: "Invalid request body." });
        if (match[3] === "/title") {
          if (
            typeof body.title !== "string" ||
            !body.title.trim() ||
            body.title.trim().length > 100
          )
            return json(response, 400, {
              error: "The title must contain 1–100 characters.",
            });
          return json(
            response,
            200,
            await service.rename(key, match[2], body.title),
          );
        }
        if (match[3] === "/track")
          return json(response, 200, await service.track(key, match[2]));
        if (
          !body ||
          typeof body.source !== "string" ||
          typeof body.destination !== "string"
        ) {
          return json(response, 400, {
            error: "Source and destination tags are required.",
          });
        }
        return json(
          response,
          200,
          await service.move(key, match[2], body.source, body.destination),
        );
      }
      return json(response, 405, { error: "Method not allowed." });
    }
    if (!production && vite)
      return vite.middlewares(request, response, () =>
        json(response, 404, { error: "Not found." }),
      );
    if (request.method !== "GET" && request.method !== "HEAD")
      return json(response, 405, { error: "Method not allowed." });
    const path = resolve(
      root,
      "." +
        decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname),
    );
    if (!path.startsWith(root + sep))
      return json(response, 403, { error: "Invalid path." });
    try {
      if (!(await stat(path)).isFile())
        return json(response, 404, { error: "Not found." });
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      response.writeHead(200, {
        "Content-Type": mime[extname(path)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      response.end(
        request.method === "HEAD" ? undefined : await readFile(path),
      );
    } catch {
      json(response, 404, {
        error: "UI build not found. Run pnpm build first.",
      });
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(`Refined PrUn board: http://localhost:${port}`);
  return {
    close: async () => {
      await vite?.close();
      server.close();
    },
  };
}
