import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = { opportunities: [], applications: [], confirmations: [], audit: [], attempts: [], idempotency: [] };

export class JsonStore {
  #file;
  #state;
  #pending = Promise.resolve();

  constructor(file) { this.#file = path.resolve(file); }

  async init() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      this.#state = JSON.parse(await readFile(this.#file, "utf8"));
      this.#state.idempotency ??= [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
    }
    return this;
  }

  snapshot() { return structuredClone(this.#state); }

  async reserveIdempotency({ profileId, action, key, requestHash }) {
    return this.mutate(async (state) => {
      state.idempotency ??= [];
      const existing = state.idempotency.find((item) => item.profileId === profileId
        && item.action === action && item.key === key);
      if (existing) return { state: existing.status, requestHash: existing.requestHash,
        ...(existing.response !== undefined ? { response: existing.response } : {}) };
      state.idempotency.push({ profileId, action, key, requestHash, status: "pending",
        createdAt: new Date().toISOString() });
      return { state: "reserved", requestHash };
    });
  }

  getIdempotency({ profileId, action, key }) {
    const existing = this.#state.idempotency?.find((item) => item.profileId === profileId
      && item.action === action && item.key === key);
    return existing ? structuredClone({ state: existing.status, requestHash: existing.requestHash,
      ...(existing.response !== undefined ? { response: existing.response } : {}) }) : null;
  }

  async completeIdempotency({ profileId, action, key, requestHash, response }) {
    return this.mutate(async (state) => {
      const existing = state.idempotency?.find((item) => item.profileId === profileId
        && item.action === action && item.key === key);
      if (!existing || existing.status !== "pending" || existing.requestHash !== requestHash) {
        throw new Error("idempotency reservation was lost before completion");
      }
      existing.status = "completed";
      existing.response = structuredClone(response);
      existing.completedAt = new Date().toISOString();
    });
  }

  async abortIdempotency({ profileId, action, key, requestHash }) {
    return this.mutate(async (state) => {
      const index = state.idempotency?.findIndex((item) => item.profileId === profileId
        && item.action === action && item.key === key && item.requestHash === requestHash
        && item.status === "pending") ?? -1;
      if (index >= 0) state.idempotency.splice(index, 1);
    });
  }

  async mutate(fn) {
    const operation = this.#pending.then(async () => {
      const draft = structuredClone(this.#state);
      const result = await fn(draft);
      this.#state = draft;
      await this.#persist();
      return structuredClone(result);
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  async #persist() {
    const temporary = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#file);
  }
}
