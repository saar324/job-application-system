import { SOURCE_COOLDOWN_MS } from "./source-cooldown.js";

// Provider allowances. Private config may lower a window but never raise it.
export const SOURCE_QUOTA_DEFAULTS = Object.freeze({
  adzuna: Object.freeze({ minute: 25, day: 250, week: 1_000, month: 2_500 }),
  jobspipe: Object.freeze({ second: 2, credits_month: 1_000 })
});

// Credit windows meter what the provider bills (for example distinct jobs
// returned), not requests. They are charged only through an explicit
// `credits` estimate on `reserve` and corrected afterwards with `settle`.
export const isCreditWindow = (window) => window.startsWith("credits_");
// Windows short enough that the service waits for the next one instead of
// refusing the request.
export const PACED_WINDOWS = Object.freeze(["second"]);
export const KEY_REJECTED_HOLD_MS = 365 * 86_400_000;

const DAY_MS = 86_400_000;
const bounds = (start, end) => ({ start: new Date(start).toISOString(), resetAt: new Date(end).toISOString() });

// Calendar windows in UTC; weeks start on Monday. A new window kind only needs
// a function returning a stable `start` key and the `resetAt` time (or null).
export const QUOTA_WINDOWS = Object.freeze({
  second: (at) => { const start = Math.floor(at / 1_000) * 1_000; return bounds(start, start + 1_000); },
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
  },
  credits_month: (at) => QUOTA_WINDOWS.month(at)
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
  if (refusal.code === "key_rejected") {
    return Object.assign(new Error(`key_rejected: ${sourceId} is paused until its API key changes`), refusal);
  }
  return refusal.code === "quota_exhausted" && refusal.window
    ? Object.assign(new Error(`quota_exhausted: ${sourceId} ${refusal.window} allowance of ${refusal.limit
    } ${isCreditWindow(refusal.window) ? "credits" : "requests"} resets at ${refusal.resetAt}`), refusal)
    : Object.assign(new Error(`${refusal.code}: ${sourceId} is cooling down until ${refusal.resetAt}`), refusal);
}

const holdCode = (reason) => String(reason).split(":", 1)[0];

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

  // Request windows are charged `cost`. Credit windows are charged only when
  // `credits` is given, and then as much of it as remains (at least 1), so the
  // caller can size its request to the returned `credits` before sending it.
  async reserve(sourceId, limits, cost = 1, { credits } = {}) {
    if (!this.available) throw new Error("the configured store cannot persist source quota");
    const at = this.now();
    const windows = this.#windows(limits, at).flatMap((item) => isCreditWindow(item.window)
      ? credits === undefined ? [] : [{ ...item, cost: Math.max(1, Math.floor(credits)), clamp: true }]
      : cost > 0 ? [{ ...item, cost }] : []);
    const result = await this.store.reserveSourceQuota({ sourceId, cost, at: new Date(at).toISOString(),
      windows: windows.map(({ window, start, limit, cost: charge, clamp }) => ({ window, start, limit,
        cost: charge, ...(clamp ? { clamp } : {}) })) });
    if (result.reserved) {
      const creditWindows = windows.filter((item) => item.clamp);
      return { reserved: true, ...(creditWindows.length ? { sourceId,
        credits: Math.min(...creditWindows.map((item) => result.charged?.[item.window] ?? item.cost)),
        creditWindows: creditWindows.map(({ window, start }) => ({ window, start })) } : {}) };
    }
    if (result.hold) return { reserved: false, code: holdCode(result.hold.reason), resetAt: result.hold.until };
    const blocked = windows.find((item) => item.window === result.window);
    return { reserved: false, code: "quota_exhausted", window: result.window, limit: blocked.limit,
      used: result.used, resetAt: blocked.resetAt };
  }

  // Records what the provider actually billed for a credit reservation. The
  // difference is returned to (or, if the provider charged more, taken from)
  // the windows that were reserved.
  async settle(reservation, charged) {
    if (!this.available || !reservation?.creditWindows?.length) return;
    const actual = Number.isFinite(Number(charged)) ? Math.max(0, Math.round(Number(charged))) : reservation.credits;
    const delta = actual - reservation.credits;
    if (delta) {
      await this.store.settleSourceQuota({ sourceId: reservation.sourceId, windows: reservation.creditWindows,
        delta, at: new Date(this.now()).toISOString() });
    }
  }

  async hold(sourceId, reason = "rate_limited", durationMs = SOURCE_COOLDOWN_MS[reason]) {
    if (!this.available) return null;
    const until = new Date(this.now() + durationMs).toISOString();
    await this.store.holdSourceQuota({ sourceId, reason, until });
    return { reason: holdCode(reason), until };
  }

  // The ledger view handed to one keyed adapter. `reserve(credits)` charges
  // only credit windows and throws a `quota_exhausted` (or hold) error marked
  // `notSent`; `hold(reason, { window })` pauses until that window resets.
  forSource(sourceId, limits, { fingerprint } = {}) {
    return Object.freeze({
      reserve: async (credits) => {
        const reservation = await this.reserve(sourceId, limits, 0, { credits });
        if (!reservation.reserved) throw Object.assign(quotaError(sourceId, reservation), { notSent: true });
        return reservation;
      },
      settle: (reservation, charged) => this.settle(reservation, charged),
      hold: (reason, { window } = {}) => {
        const at = this.now();
        const durationMs = window ? Date.parse(QUOTA_WINDOWS[window](at).resetAt) - at
          : reason === "key_rejected" ? KEY_REJECTED_HOLD_MS : SOURCE_COOLDOWN_MS[reason];
        return this.hold(sourceId, reason === "key_rejected" && fingerprint ? `key_rejected:${fingerprint}` : reason,
          durationMs);
      }
    });
  }

  // A `key_rejected:<fingerprint>` hold lasts until a different key is
  // configured; this lifts it once the current key no longer matches.
  async releaseStaleKeyHold(sourceId, fingerprint) {
    if (!this.available) return false;
    const { hold } = await this.store.sourceQuotaUsage({ sourceId, windows: [],
      at: new Date(this.now()).toISOString() });
    if (!hold || holdCode(hold.reason) !== "key_rejected" || hold.reason === `key_rejected:${fingerprint}`) return false;
    await this.store.releaseSourceQuotaHold({ sourceId, reason: hold.reason });
    return true;
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
      ...(hold ? { cooldown: { reason: holdCode(hold.reason), until: hold.until } } : {})
    };
  }
}
