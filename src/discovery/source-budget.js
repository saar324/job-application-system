import { performance } from "node:perf_hooks";

export class SourceTimeoutError extends Error {
  constructor() { super("source wall-clock budget exceeded"); this.name = "SourceTimeoutError"; }
}

export class SourceBudget {
  constructor(durationMs, now = () => performance.now()) {
    this.now = now;
    this.deadline = now() + durationMs;
  }

  remainingMs() { return Math.max(0, Math.ceil(this.deadline - this.now())); }

  timeoutMs(maximum) {
    const remaining = this.remainingMs();
    if (remaining <= 0) throw new SourceTimeoutError();
    return Math.max(1, Math.min(maximum, remaining));
  }

  async run(operation, maximum = Number.MAX_SAFE_INTEGER) {
    const timeout = this.timeoutMs(maximum);
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new SourceTimeoutError()), timeout); })]);
    } finally { clearTimeout(timer); }
  }

  async sleep(durationMs) {
    if (durationMs <= 0) return;
    const timeout = this.timeoutMs(durationMs);
    await new Promise((resolve) => setTimeout(resolve, timeout));
    if (timeout < durationMs || this.remainingMs() <= 0) throw new SourceTimeoutError();
  }
}
