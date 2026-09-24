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

  async reserveSourceQuota({ sourceId, windows, cost = 1, at = new Date().toISOString() }) {
    return this.mutate((state) => {
      const ledger = state.sourceQuota ??= { usage: [], holds: [] };
      ledger.holds = ledger.holds.filter((item) => item.until > at);
      const hold = ledger.holds.find((item) => item.sourceId === sourceId);
      if (hold) return { reserved: false, hold: { reason: hold.reason, until: hold.until } };
      ledger.usage = ledger.usage.filter((item) => item.sourceId !== sourceId
        || windows.some((window) => window.window === item.window && window.start === item.start)
        || !windows.some((window) => window.window === item.window));
      const rows = windows.map((window) => ({ window, row: ledger.usage.find((item) => item.sourceId === sourceId
        && item.window === window.window && item.start === window.start) }));
      const charged = Object.fromEntries(rows.map(({ window, row }) => [window.window, window.clamp
        ? Math.min(window.cost ?? cost, window.limit - (row?.used ?? 0)) : window.cost ?? cost]));
      const blocked = rows.find(({ window, row }) => window.clamp ? charged[window.window] < 1
        : (row?.used ?? 0) + charged[window.window] > window.limit);
      if (blocked) return { reserved: false, window: blocked.window.window, used: blocked.row?.used ?? 0 };
      for (const { window, row } of rows) {
        if (row) row.used += charged[window.window];
        else ledger.usage.push({ sourceId, window: window.window, start: window.start, used: charged[window.window] });
      }
      return { reserved: true, charged };
    });
  }

  async settleSourceQuota({ sourceId, windows, delta }) {
    return this.mutate((state) => {
      const ledger = state.sourceQuota ??= { usage: [], holds: [] };
      for (const window of windows) {
        const row = ledger.usage.find((item) => item.sourceId === sourceId && item.window === window.window
          && item.start === window.start);
        if (row) row.used = Math.max(0, row.used + delta);
        else ledger.usage.push({ sourceId, window: window.window, start: window.start, used: Math.max(0, delta) });
      }
    });
  }

  async releaseSourceQuotaHold({ sourceId, reason }) {
    return this.mutate((state) => {
      const ledger = state.sourceQuota ??= { usage: [], holds: [] };
      ledger.holds = ledger.holds.filter((item) => item.sourceId !== sourceId || item.reason !== reason);
    });
  }

  async holdSourceQuota({ sourceId, reason, until }) {
    return this.mutate((state) => {
      const ledger = state.sourceQuota ??= { usage: [], holds: [] };
      const existing = ledger.holds.find((item) => item.sourceId === sourceId);
      if (!existing) ledger.holds.push({ sourceId, reason, until });
      else if (until > existing.until) Object.assign(existing, { reason, until });
    });
  }

  async sourceQuotaUsage({ sourceId, windows, at = new Date().toISOString() }) {
    const ledger = this.#state.sourceQuota ?? { usage: [], holds: [] };
    const hold = ledger.holds.find((item) => item.sourceId === sourceId && item.until > at);
    return { used: Object.fromEntries(windows.map((window) => [window.window, ledger.usage.find((item) =>
      item.sourceId === sourceId && item.window === window.window && item.start === window.start)?.used ?? 0])),
    hold: hold ? { reason: hold.reason, until: hold.until } : null };
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
