import { SOURCE_COOLDOWN_MS } from "./source-cooldown.js";

// Provider allowances. Private config may lower a window but never raise it.
export const SOURCE_QUOTA_DEFAULTS = Object.freeze({
  adzuna: Object.freeze({ minute: 25, day: 250, week: 1_000, month: 2_500 })
});

const DAY_MS = 86_400_000;
const bounds = (start, end) => ({ start: new Date(start).toISOString(), resetAt: new Date(end).toISOString() });

// Calendar windows in UTC; weeks start on Monday. A new window kind only needs
// a function returning a stable `start` key and the `resetAt` time (or null).
export const QUOTA_WINDOWS = Object.freeze({
  minute: (at) => { const start = Math.floor(at / 60_000) * 60_000; return bounds(start, start + 60_000); },
  day: (at) => { const start = Math.floor(at / DAY_MS) * DAY_MS; return bounds(start, start + DAY_MS); },
  week: (at) => {
    const day = Math.floor(at / DAY_MS);
    const start = (day - ((day + 3) % 7)) * DAY_MS;
    return bounds(start, start + 7 * DAY_MS);
  },
  month: (at) => {
    const date = new Date(at);
    return bounds(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  }
});

export function validateQuotaOverrides(sourceId, overrides) {
  const defaults = SOURCE_QUOTA_DEFAULTS[sourceId];
  if (!defaults) throw new Error(`discovery.sourceOptions.${sourceId}.quota is not supported`);
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error(`discovery.sourceOptions.${sourceId}.quota must be an object`);
  }
  for (const [window, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(defaults, window) || !Number.isInteger(value) || value < 0 || value > defaults[window]) {
      throw new Error(`discovery.sourceOptions.${sourceId}.quota.${window} must be an integer from 0 to ${
        defaults[window] ?? "the provider default"}`);
    }
  }
  return overrides;
}

export function quotaLimits(sourceId, overrides = {}) {
  const defaults = SOURCE_QUOTA_DEFAULTS[sourceId];
  if (!defaults) return null;
  return Object.fromEntries(Object.entries(defaults).map(([window, limit]) => {
    const lowered = overrides?.[window];
    return [window, Number.isInteger(lowered) && lowered >= 0 && lowered < limit ? lowered : limit];
  }));
}

export function quotaError(sourceId, refusal) {
  return refusal.code === "quota_exhausted"
    ? Object.assign(new Error(`quota_exhausted: ${sourceId} ${refusal.window} allowance of ${refusal.limit
    } requests resets at ${refusal.resetAt}`), refusal)
    : Object.assign(new Error(`${refusal.code}: ${sourceId} is cooling down until ${refusal.resetAt}`), refusal);
}

// Deployment-wide request ledger. The store performs the check-and-increment
// for every window in one transaction, so concurrent scans and restarts cannot
// overspend a provider allowance.
export class SourceQuota {
  constructor(store, { now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
  }

  get available() { return typeof this.store?.reserveSourceQuota === "function"; }

  #windows(limits, at) {
    return Object.entries(limits).map(([window, limit]) => ({ window, limit, ...QUOTA_WINDOWS[window](at) }));
  }

  async reserve(sourceId, limits, cost = 1) {
    if (!this.available) throw new Error("the configured store cannot persist source quota");
    const at = this.now();
    const windows = this.#windows(limits, at);
    const result = await this.store.reserveSourceQuota({ sourceId, cost, at: new Date(at).toISOString(),
      windows: windows.map(({ window, start, limit }) => ({ window, start, limit })) });
    if (result.reserved) return { reserved: true };
    if (result.hold) return { reserved: false, code: result.hold.reason, resetAt: result.hold.until };
    const blocked = windows.find((item) => item.window === result.window);
    return { reserved: false, code: "quota_exhausted", window: result.window, limit: blocked.limit,
      used: result.used, resetAt: blocked.resetAt };
  }

  async hold(sourceId, reason = "rate_limited", durationMs = SOURCE_COOLDOWN_MS[reason]) {
    if (!this.available) return null;
    const until = new Date(this.now() + durationMs).toISOString();
    await this.store.holdSourceQuota({ sourceId, reason, until });
    return { reason, until };
  }

  async usage(sourceId, limits) {
    if (!this.available || !limits) return null;
    const at = this.now();
    const windows = this.#windows(limits, at);
    const { used, hold } = await this.store.sourceQuotaUsage({ sourceId, at: new Date(at).toISOString(),
      windows: windows.map(({ window, start }) => ({ window, start })) });
    return {
      windows: Object.fromEntries(windows.map(({ window, limit, resetAt }) => [window, { limit,
        used: used[window] ?? 0, remaining: Math.max(0, limit - (used[window] ?? 0)), resetAt }])),
      ...(hold ? { cooldown: { reason: hold.reason, until: hold.until } } : {})
    };
  }
}
