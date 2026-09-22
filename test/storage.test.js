import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteStore } from "../src/sqlite-store.js";
import { initializeStore } from "../src/storage.js";

test("legacy migration resumes when an empty SQLite file already exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-migration-"));
  const databaseFile = path.join(directory, "state.sqlite");
  const legacyFile = path.join(directory, "state.json");
  const empty = await new SqliteStore(databaseFile).init();
  empty.close();
  await writeFile(legacyFile, JSON.stringify({
    opportunities: [{ id: "op-1", profileId: "profile-1", applyUrl: "https://example.test/apply" }],
    applications: [{ id: "app-1", opportunityId: "op-1", profileId: "profile-1", status: "queued" }],
    confirmations: [], audit: []
  }));

  const migrated = await initializeStore({ JOB_SERVER_DATABASE: databaseFile, JOB_SERVER_DATA: legacyFile });
  assert.equal(migrated.snapshot().applications[0].id, "app-1");
  migrated.close();

  await writeFile(legacyFile, JSON.stringify({
    opportunities: [], applications: [], confirmations: [], audit: []
  }));
  const reopened = await initializeStore({ JOB_SERVER_DATABASE: databaseFile, JOB_SERVER_DATA: legacyFile });
  assert.equal(reopened.snapshot().applications[0].id, "app-1");
  reopened.close();
});

test("legacy migration refuses to overwrite divergent unmarked SQLite state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-migration-"));
  const databaseFile = path.join(directory, "state.sqlite");
  const legacyFile = path.join(directory, "state.json");
  const existing = await new SqliteStore(databaseFile).init();
  await existing.mutate(async (state) => state.opportunities.push({
    id: "sqlite-op", profileId: "profile-1", applyUrl: "https://example.test/sqlite"
  }));
  existing.close();
  await writeFile(legacyFile, JSON.stringify({
    opportunities: [{ id: "json-op", profileId: "profile-1", applyUrl: "https://example.test/json" }],
    applications: [], confirmations: [], audit: []
  }));
  await assert.rejects(
    initializeStore({ JOB_SERVER_DATABASE: databaseFile, JOB_SERVER_DATA: legacyFile }),
    /differs from the legacy JSON/
  );
  const reopened = await new SqliteStore(databaseFile).init();
  assert.equal(reopened.snapshot().opportunities[0].id, "sqlite-op");
  reopened.close();
});
