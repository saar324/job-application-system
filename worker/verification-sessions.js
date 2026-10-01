import { randomUUID } from "node:crypto";

const keys = ["profileId", "applicationId", "attemptId", "destination", "previewFingerprint"];
const hold = (reasonCode) => ({ status: "needs_human", phase: "final_action_started",
  requirements: [{ kind: "submission_email_verification", reasonCode }] });

// Transient browser continuations only. Neither codes nor callback payloads are
// retained, serialized, logged, or recoverable after a process restart.
export class VerificationSessions {
  #sessions = new Map();
  constructor({ ttlMs = 15 * 60_000, maxSessions = 3, now = Date.now } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60_000
      || !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 3) throw new Error("Invalid verification limits");
    this.ttlMs = ttlMs; this.maxSessions = maxSessions; this.now = now;
  }
  get size() { return this.#sessions.size; }
  retain({ binding, context, page, continueVerification }) {
    if (!keys.every(key => typeof binding?.[key] === "string" && binding[key])
      || !/^[a-f0-9]{64}$/i.test(binding.previewFingerprint)
      || typeof continueVerification !== "function" || page.isClosed()
      || page.url() !== binding.destination) throw new Error("Invalid verification session");
    if (this.#sessions.size >= this.maxSessions
      || [...this.#sessions.values()].some(item => item.binding.profileId === binding.profileId)) throw new Error("Verification capacity unavailable");
    const id = randomUUID(), expiresAt = this.now() + this.ttlMs;
    const safeBinding = Object.fromEntries(keys.map(key => [key, binding[key]]));
    const timer = setTimeout(() => { void this.#close(id); }, this.ttlMs); timer.unref?.();
    this.#sessions.set(id, { binding: safeBinding, expiresAt, context, page, continueVerification, timer, claimed: false });
    return { id, expiresAt, ...safeBinding };
  }
  async #close(id) {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id); clearTimeout(session.timer);
    await session.context.close().catch(() => {});
  }
  async closeAll() { await Promise.all([...this.#sessions.keys()].map(id => this.#close(id))); }
  async verify(input, { authorize, persistReceipt }) {
    const session = this.#sessions.get(input?.sessionId);
    if (!session) return hold("verification_session_unavailable");
    if (session.expiresAt <= this.now() || session.page.isClosed()) {
      await this.#close(input.sessionId); return hold("verification_session_expired");
    }
    if (!keys.every(key => input[key] === session.binding[key])
      || session.page.url() !== session.binding.destination) return hold("verification_binding_changed");
    if (!/^[A-Za-z0-9]{8}$/.test(input.code ?? "")) return hold("verification_code_invalid");
    if (session.claimed) return hold("verification_already_claimed");
    session.claimed = true;
    try {
      const permitted = await authorize({ ...session.binding, sessionId: input.sessionId });
      if (permitted?.allowed !== true) { session.claimed = false; return hold("verification_authority_denied"); }
      if (this.#sessions.get(input.sessionId) !== session || session.expiresAt <= this.now()
        || session.page.isClosed()) {
        await this.#close(input.sessionId); return hold("verification_session_expired");
      }
      if (session.page.url() !== session.binding.destination) return hold("verification_binding_changed");
      const result = await session.continueVerification(input.code);
      if (result?.status !== "submitted" || !result.receipt) return hold("verification_outcome_unconfirmed");
      // Do not forward arbitrary callback diagnostics which could contain a code.
      const safeResult = { status: "submitted", receipt: result.receipt };
      if (JSON.stringify(safeResult).includes(input.code)) return hold("verification_receipt_unsafe");
      await persistReceipt(safeResult);
      this.#sessions.delete(input.sessionId); clearTimeout(session.timer);
      // Caller owns successful context cleanup after receipt capture.
      return safeResult;
    } catch { return hold("verification_outcome_unconfirmed"); }
  }
}
