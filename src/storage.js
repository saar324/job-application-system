import { createHash } from "node:crypto";
import { access, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { SqliteStore, validateStateRelationships } from "./sqlite-store.js";

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function initializeStore(env = process.env) {
  const databaseFile = path.resolve(env.JOB_SERVER_DATABASE ?? "./data/state.sqlite");
  const legacyFile = path.resolve(env.JOB_SERVER_DATA ?? "./data/state.json");
  const store = await new SqliteStore(databaseFile, {
    busyTimeoutMs: Number(env.JOB_SERVER_DATABASE_BUSY_TIMEOUT_MS ?? 5_000)
  }).init();
  try {
    if (await exists(legacyFile)) {
      const source = await readFile(legacyFile, "utf8");
      const state = JSON.parse(source);
      validateStateRelationships(state);
      const markerKey = `legacy_import:${createHash("sha256").update(legacyFile).digest("hex")}`;
      if (store.metadata(markerKey) === undefined) {
        const fingerprint = createHash("sha256").update(source).digest("hex");
        const backup = `${legacyFile}.pre-sqlite-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.bak`;
        await copyFile(legacyFile, backup);
        const imported = store.importLegacyState(state, markerKey, JSON.stringify({
          source: legacyFile, fingerprint, importedAt: new Date().toISOString()
        }));
        if (imported) console.log(`migrated legacy state to SQLite; backup retained at ${backup}`);
      }
    }
    return store;
  } catch (error) {
    store.close();
    throw error;
  }
}
