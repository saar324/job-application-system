#!/usr/bin/env node
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { SqliteStore, validateStateRelationships } from "../src/sqlite-store.js";

const { values } = parseArgs({ options: {
  source: { type: "string", default: "./data/state.json" },
  database: { type: "string", default: "./data/state.sqlite" },
  "dry-run": { type: "boolean", default: false },
  force: { type: "boolean", default: false }
} });
const source = path.resolve(values.source);
const database = path.resolve(values.database);
const state = JSON.parse(await readFile(source, "utf8"));
const counts = validateStateRelationships(state);
if (values["dry-run"]) {
  console.log(JSON.stringify({ ok: true, source, database, counts }, null, 2));
  process.exit(0);
}
const store = await new SqliteStore(database).init();
const existing = store.snapshot();
if (!values.force && Object.values(existing).some((items) => items.length)) {
  throw new Error("target database is not empty; pass --force to replace it");
}
const backup = `${source}.${new Date().toISOString().replaceAll(/[:.]/g, "-")}.bak`;
await copyFile(source, backup);
await store.mutate(async (draft) => {
  for (const key of ["opportunities", "applications", "confirmations", "audit", "attempts"]) {
    draft[key] = structuredClone(state[key] ?? []);
  }
});
const imported = validateStateRelationships(store.snapshot());
if (JSON.stringify(imported) !== JSON.stringify({ ...counts, attempts: counts.attempts ?? 0 })) {
  throw new Error("import count verification failed");
}
store.close();
console.log(JSON.stringify({ ok: true, source, database, backup, counts: imported }, null, 2));
