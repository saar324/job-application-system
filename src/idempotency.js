import { createHash } from "node:crypto";

const inFlightByStore = new WeakMap();

export class IdempotencyError extends Error {
  constructor(message) {
    super(message);
    this.status = 409;
  }
}

export async function runIdempotent({ store, profileId, action, key, input, execute, waitMs = 30_000 }) {
  const requestHash = createHash("sha256").update(stableJson(input)).digest("hex");
  const identity = { profileId, action, key, requestHash };
  const reservation = await store.reserveIdempotency(identity);
  if (reservation.requestHash !== requestHash) {
    throw new IdempotencyError("Idempotency-Key was already used with different request data");
  }
  if (reservation.state === "completed") return reservation.response;

  const active = activeRequests(store);
  const activeKey = `${profileId}\u0000${action}\u0000${key}`;
  if (reservation.state === "pending") {
    const local = active.get(activeKey);
    if (local) return local;
    return waitForCompletion(store, identity, waitMs);
  }

  const operation = (async () => {
    try {
      const response = await execute();
      await store.completeIdempotency({ ...identity, response });
      return response;
    } catch (error) {
      await store.abortIdempotency(identity).catch(() => undefined);
      throw error;
    } finally {
      active.delete(activeKey);
    }
  })();
  active.set(activeKey, operation);
  return operation;
}

async function waitForCompletion(store, identity, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const current = store.getIdempotency(identity);
    if (!current) throw new IdempotencyError("The original idempotent request failed; retry the request");
    if (current.requestHash !== identity.requestHash) {
      throw new IdempotencyError("Idempotency-Key was already used with different request data");
    }
    if (current.state === "completed") return current.response;
  }
  throw new IdempotencyError("The original idempotent request is still in progress");
}

function activeRequests(store) {
  let active = inFlightByStore.get(store);
  if (!active) {
    active = new Map();
    inFlightByStore.set(store, active);
  }
  return active;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
