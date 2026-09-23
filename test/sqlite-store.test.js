import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore, validateStateRelationships } from "../src/sqlite-store.js";
import { runIdempotent } from "../src/idempotency.js";

test("SQLite store preserves normalized application state across restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-sqlite-"));
  const file = path.join(directory, "state.sqlite");
  const store = await new SqliteStore(file).init();
  await store.mutate(async (state) => {
    state.opportunities.push({ id: "op-1", profileId: "profile-1", dedupKey: "url:one", applyUrl: "https://example.test/one" });
    state.applications.push({ id: "app-1", profileId: "profile-1", opportunityId: "op-1", status: "queued",
      mode: "full_time", createdAt: new Date().toISOString() });
    state.confirmations.push({ id: "confirmation-1", profileId: "profile-1", applicationId: "app-1",
      status: "pending", kind: "missing_answer", createdAt: new Date().toISOString() });
  });
  store.close();
  const reopened = await new SqliteStore(file).init();
  assert.equal(reopened.schemaVersion(), 2);
  assert.equal(reopened.snapshot().applications[0].id, "app-1");
  reopened.close();
});

test("SQLite optimistic transactions preserve concurrent updates from separate connections", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-sqlite-"));
  const file = path.join(directory, "state.sqlite");
  const left = await new SqliteStore(file).init();
  const right = await new SqliteStore(file).init();
  await Promise.all([left, right].map((store, index) => store.mutate(async (state) => {
    await new Promise((resolve) => setTimeout(resolve, index * 5));
    state.opportunities.push({ id: `op-${index}`, profileId: "profile-1", dedupKey: `key-${index}`,
      applyUrl: `https://example.test/${index}` });
  })));
  assert.deepEqual(left.snapshot().opportunities.map((item) => item.id).sort(), ["op-0", "op-1"]);
  left.close(); right.close();
});

test("SQLite transaction rollback leaves committed state unchanged", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-sqlite-"));
  const store = await new SqliteStore(path.join(directory, "state.sqlite")).init();
  await assert.rejects(store.mutate(async (state) => {
    state.opportunities.push({ id: "broken", profileId: "profile-1" });
    throw new Error("stop");
  }), /stop/);
  assert.equal(store.snapshot().opportunities.length, 0);
  store.close();
});

test("SQLite mutations preserve unchanged normalized rows", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-sqlite-"));
  const file = path.join(directory, "state.sqlite");
  const store = await new SqliteStore(file).init();
  await store.mutate(async (state) => {
    state.opportunities.push({ id: "op-1", profileId: "profile-1", dedupKey: "key-1",
      applyUrl: "https://example.test/one" });
  });
  const observer = new DatabaseSync(file);
  const createdAt = observer.prepare("SELECT created_at FROM profiles WHERE id = 'profile-1'").get().created_at;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.mutate(async (state) => {
    state.opportunities.push({ id: "op-2", profileId: "profile-1", dedupKey: "key-2",
      applyUrl: "https://example.test/two" });
  });
  assert.equal(observer.prepare("SELECT created_at FROM profiles WHERE id = 'profile-1'").get().created_at, createdAt);
  assert.equal(observer.prepare("SELECT count(*) AS count FROM opportunities").get().count, 2);
  observer.close(); store.close();
});

test("SQLite idempotency serializes callers across connections", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-sqlite-"));
  const file = path.join(directory, "state.sqlite");
  const left = await new SqliteStore(file).init();
  const right = await new SqliteStore(file).init();
  let executions = 0;
  const request = (store) => runIdempotent({ store, profileId: "profile-1", action: "test", key: "same-key",
    input: { value: 1 }, execute: async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { id: "result-1" };
    } });
  const [first, second] = await Promise.all([request(left), request(right)]);
  assert.deepEqual(first, { id: "result-1" });
  assert.deepEqual(second, first);
  assert.equal(executions, 1);
  await assert.rejects(runIdempotent({ store: right, profileId: "profile-1", action: "test", key: "same-key",
    input: { value: 2 }, execute: async () => ({}) }), /different request data/);
  left.close(); right.close();
});

test("SQLite idempotency preserves the original operation error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-sqlite-idempotency-"));
  const store = await new SqliteStore(path.join(directory, "state.sqlite")).init();
  await assert.rejects(runIdempotent({ store, profileId: "profile-1", action: "campaign", key: "key-one",
    input: { target: 1 }, execute: async () => { throw new Error("original failure"); } }), /original failure/);
  store.close();
});

test("migration validation rejects duplicate IDs and cross-profile relationships", () => {
  const base = { opportunities: [
    { id: "op-1", profileId: "profile-1" }, { id: "op-1", profileId: "profile-1" }
  ], applications: [], confirmations: [], audit: [] };
  assert.throws(() => validateStateRelationships(base), /duplicate ids/);
  assert.throws(() => validateStateRelationships({ opportunities: [{ id: "op-1", profileId: "profile-1" }],
    applications: [{ id: "app-1", opportunityId: "op-1", profileId: "profile-2" }],
    confirmations: [], audit: [] }), /crosses profile ownership/);
});
