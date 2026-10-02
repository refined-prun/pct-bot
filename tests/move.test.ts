import { test } from "node:test";
import assert from "node:assert/strict";
import { moveTags, type TagState } from "../server/move.js";

function fixture(tags = ["open"], archived = false, failAt = 0) {
  let state: TagState = { tags, archived };
  const writes: Partial<TagState>[] = [];
  return {
    writes,
    state: () => state,
    adapter: {
      read: async () => ({ ...state, tags: [...state.tags] }),
      write: async (change: Partial<TagState>) => {
        writes.push(change);
        if (writes.length === failAt) throw new Error("Missing permissions");
        state = { ...state, ...change };
      },
    },
  };
}

test("adds destination before removing source and preserves unrelated tags", async () => {
  const f = fixture(["open", "other"]);
  await moveTags(f.adapter, "open", "done");
  assert.deepEqual(f.writes, [
    { tags: ["open", "other", "done"] },
    { tags: ["other", "done"] },
  ]);
});
test("an add failure never removes the original tag", async () => {
  const f = fixture(["open"], false, 1);
  const result = await moveTags(f.adapter, "open", "done");
  assert.match(result.warning!, /Missing permissions/);
  assert.deepEqual(f.state().tags, ["open"]);
  assert.equal(f.writes.length, 1);
});
test("a remove failure keeps both tags, and retry finishes the move", async () => {
  const f = fixture(["open"], false, 2);
  assert.ok((await moveTags(f.adapter, "open", "done")).warning);
  assert.deepEqual(f.state().tags, ["open", "done"]);
  assert.equal((await moveTags(f.adapter, "open", "done")).warning, undefined);
  assert.deepEqual(f.state().tags, ["done"]);
});
test("closed and locked posts can be moved without altering their final archive state", async () => {
  const f = fixture(["open"], true);
  await moveTags(f.adapter, "open", "done");
  assert.deepEqual(f.writes[0], { tags: ["open", "done"], archived: false });
  assert.deepEqual(f.state(), { tags: ["done"], archived: true });
});
test("archive restoration is attempted even after a failed write", async () => {
  const f = fixture(["open"], true, 2);
  await moveTags(f.adapter, "open", "done");
  assert.equal(f.state().archived, true);
  assert.deepEqual(f.state().tags, ["open", "done"]);
});
test("archive restoration failures are disclosed", async () => {
  const f = fixture(["open"], true, 3);
  assert.match(
    (await moveTags(f.adapter, "open", "done")).warning!,
    /closed again/,
  );
});
test("five-tag limit prevents unsafe remove-first behavior", async () => {
  const f = fixture(["open", "a", "b", "c", "d"]);
  await assert.rejects(moveTags(f.adapter, "open", "done"), /five tags/);
  assert.equal(f.writes.length, 0);
});
test("stale source is rejected but completed retries are harmless", async () => {
  const f = fixture(["other"]);
  await assert.rejects(
    moveTags(f.adapter, "open", "done"),
    /changed in Discord/,
  );
  const finished = fixture(["done"]);
  await moveTags(finished.adapter, "open", "done");
  assert.equal(finished.writes.length, 0);
});
test("concurrent unrelated tag changes between writes are retained", async () => {
  const f = fixture(["open"]);
  let reads = 0;
  const read = f.adapter.read;
  f.adapter.read = async () => {
    const state = await read();
    return ++reads === 2
      ? { ...state, tags: [...state.tags, "external"] }
      : state;
  };
  await moveTags(f.adapter, "open", "done");
  assert.deepEqual(f.state().tags, ["done", "external"]);
});
