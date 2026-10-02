import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "discord.js";
import { get, request } from "node:http";
import { startBoardServer } from "../server/http.js";
import { FORUMS, GUILD_ID } from "../server/discord-board.js";

test("local API rejects foreign hosts, origins, and unauthenticated mutations", async () => {
  const oldPort = process.env.BOARD_PORT;
  const oldMode = process.env.NODE_ENV;
  process.env.BOARD_PORT = "15173";
  process.env.NODE_ENV = "production";
  let discordRequests = 0;
  const client = {
    isReady: () => true,
    user: { username: "test" },
    rest: {
      get: async () => {
        discordRequests++;
        throw new Error("Unexpected Discord request");
      },
    },
  } as unknown as Client;
  const server = await startBoardServer(client);
  const base = "http://127.0.0.1:15173";
  try {
    const foreignHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        get(
          `${base}/api/session`,
          { headers: { Host: "attacker.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        ).on("error", reject);
      },
    );
    assert.equal(foreignHostStatus, 403);
    assert.equal(
      (
        await fetch(`${base}/api/session`, {
          headers: { Origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/session`, {
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
      403,
    );
    const session = await fetch(`${base}/api/session`);
    assert.equal(session.headers.get("cache-control"), "no-store");
    const { token } = (await session.json()) as { token: string };
    assert.equal(token.length, 64);
    const path = `${base}/api/boards/features/tickets/1555374930600923226/move`;
    assert.equal(
      (
        await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Board-Token": token,
          },
          body: "null",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Board-Token": token,
          },
          body: "{broken",
        })
      ).status,
      400,
    );
    for (const action of ["title", "track"]) {
      const actionPath = path.replace(/move$/, action);
      assert.equal(
        (
          await fetch(actionPath, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(actionPath, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Board-Token": token,
              Origin: "https://attacker.example",
            },
            body: "{}",
          })
        ).status,
        403,
      );
      assert.equal((await fetch(actionPath, { method: "GET" })).status, 405);
    }
    for (const title of ["", "  ", "a".repeat(101), null]) {
      assert.equal(
        (
          await fetch(path.replace(/move$/, "title"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Board-Token": token,
            },
            body: JSON.stringify({ title }),
          })
        ).status,
        400,
      );
    }
    assert.equal(discordRequests, 0);
  } finally {
    await server.close();
    if (oldPort === undefined) delete process.env.BOARD_PORT;
    else process.env.BOARD_PORT = oldPort;
    if (oldMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldMode;
  }
});

test("board links allow cross-site document navigation but not API or embedded requests", async () => {
  const oldPort = process.env.BOARD_PORT;
  const oldMode = process.env.NODE_ENV;
  process.env.BOARD_PORT = "15174";
  process.env.NODE_ENV = "development";
  const server = await startBoardServer({ isReady: () => true } as Client);
  const navigationHeaders = {
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
  };
  function load(path: string, method = "GET", headers = navigationHeaders) {
    return new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const req = request(
          `http://127.0.0.1:15174${path}`,
          { method, headers },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () =>
              resolve({ status: response.statusCode, body }),
            );
            response.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
  }
  try {
    for (const path of ["/", "/index.html"]) {
      const page = await load(path);
      assert.equal(page.status, 200);
      assert.match(page.body, /<div id="app"><\/div>/);
      assert.equal((await load(path, "HEAD")).status, 200);
    }
    for (const path of [
      "/api/session",
      "/api/boards/features",
      "/api/boards/features/tickets/1555374930600923226/move",
    ]) {
      assert.equal((await load(path)).status, 403);
      assert.equal((await load(path, "POST")).status, 403);
    }
    assert.equal((await load("/", "POST")).status, 403);
    assert.equal(
      (
        await load("/", "GET", {
          ...navigationHeaders,
          "Sec-Fetch-Dest": "iframe",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await load("/", "GET", {
          ...navigationHeaders,
          "Sec-Fetch-Mode": "cors",
        })
      ).status,
      403,
    );
  } finally {
    await server.close();
    if (oldPort === undefined) delete process.env.BOARD_PORT;
    else process.env.BOARD_PORT = oldPort;
    if (oldMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldMode;
  }
});

test("authenticated title and track routes update and return the selected ticket", async () => {
  const oldPort = process.env.BOARD_PORT;
  const oldMode = process.env.NODE_ENV;
  process.env.BOARD_PORT = "15175";
  process.env.NODE_ENV = "production";
  const id = "1555374930600923226";
  const state = {
    id,
    name: "Before",
    type: 11,
    parent_id: FORUMS.features.id,
    guild_id: GUILD_ID,
    applied_tags: ["open"],
  };
  let tracks = 0;
  const server = await startBoardServer(
    {
      isReady: () => true,
      user: { username: "test" },
      rest: {
        get: async () => state,
        patch: async (_path: string, { body }: { body: { name: string } }) => {
          state.name = body.name;
        },
      },
    } as unknown as Client,
    async (ticketId) => {
      assert.equal(ticketId, id);
      tracks++;
      state.applied_tags = ["tracked"];
      return {
        issueUrl: "https://github.com/example/repo/issues/1",
        alreadyTracked: false,
      };
    },
  );
  try {
    const base = "http://127.0.0.1:15175/api";
    const { token } = (await (await fetch(`${base}/session`)).json()) as {
      token: string;
    };
    const headers = {
      "Content-Type": "application/json",
      "X-Board-Token": token,
    };
    const rename = await fetch(`${base}/boards/features/tickets/${id}/title`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: " New title " }),
    });
    assert.equal(rename.status, 200);
    assert.equal((await rename.json()).ticket.title, "New title");
    const track = await fetch(`${base}/boards/features/tickets/${id}/track`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(track.status, 200);
    const result = await track.json();
    assert.equal(result.issueUrl, "https://github.com/example/repo/issues/1");
    assert.deepEqual(result.ticket.tags, ["tracked"]);
    assert.equal(tracks, 1);
  } finally {
    await server.close();
    if (oldPort === undefined) delete process.env.BOARD_PORT;
    else process.env.BOARD_PORT = oldPort;
    if (oldMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldMode;
  }
});
