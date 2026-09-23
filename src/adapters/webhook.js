import { NeedsInputError, NeedsReviewError, NeedsResearchError, PostingUnavailableError,
  RetryableExecutionError } from "./errors.js";

export class WebhookAdapter {
  name = "webhook";
  constructor({ url, token }) {
    if (!url) throw new Error("APPLICATION_WEBHOOK_URL is required for the webhook adapter");
    this.url = url;
    this.token = token;
  }
  async attemptStatus(applicationId) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(applicationId ?? "")) throw new Error("invalid application ID");
    const endpoint = new URL(this.url);
    endpoint.pathname = `/v1/attempts/${applicationId}`;
    endpoint.search = "";
    const response = await fetch(endpoint, {
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`worker attempt status returned HTTP ${response.status}`);
    const body = await response.json();
    if (!["active", "submitted", "unknown", "before_final_action", "final_action_started"].includes(body.status)) {
      throw new Error("worker attempt status is invalid");
    }
    return body;
  }
  async submit(payload) {
    let response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180_000)
      });
    } catch (error) {
      const status = await this.attemptStatus(payload.application?.id).catch(() => null);
      if (status?.status === "submitted" && status.receipt?.submittedAt && status.receipt?.finalUrl) {
        return status.receipt;
      }
      if (status?.status === "before_final_action") {
        throw new RetryableExecutionError(`The browser stopped before the final action: ${error.message}`);
      }
      throw new NeedsReviewError(`The application worker response was lost: ${error.message}`, [{
        kind: "submission_unverified", action: "manual_review",
        message: status?.status === "active"
          ? "The original browser attempt is still running; wait for it to finish and reconcile before retrying"
          : status?.status === "before_final_action"
            ? "The worker stopped before the final action; review the application before retrying"
          : "Check whether the application was received before retrying"
      }]);
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 409 && body.status === "needs_input") {
      throw new NeedsInputError(body.message ?? "The application worker needs input", body.requirements ?? [], body);
    }
    if (response.status === 409 && body.status === "needs_human") {
      throw new NeedsReviewError(body.message ?? "The application worker needs human review", body.requirements ?? [], body);
    }
    if (response.status === 409 && body.status === "needs_research") {
      throw new NeedsResearchError(body.message ?? "The application needs company research", body.questions ?? [], body);
    }
    if (response.status === 409 && body.status === "posting_unavailable") {
      throw new PostingUnavailableError(body.message ?? "The employer posting is unavailable", body);
    }
    if (response.status >= 500) {
      const status = await this.attemptStatus(payload.application?.id).catch(() => null);
      if (status?.status === "submitted" && status.receipt?.submittedAt && status.receipt?.finalUrl) {
        return status.receipt;
      }
      if (status?.status === "before_final_action") {
        throw new RetryableExecutionError(body.error ?? `application worker returned HTTP ${response.status}`);
      }
      throw new NeedsReviewError(body.error ?? `application worker returned HTTP ${response.status}`, [{
        kind: "submission_unverified", action: "manual_review",
        message: "Check whether the application was received before retrying"
      }]);
    }
    if (!response.ok) throw new Error(body.error ?? `application worker returned HTTP ${response.status}`);
    if (body.status !== "submitted" || !body.receipt?.submittedAt || !body.receipt?.finalUrl) {
      throw new NeedsReviewError("application worker did not return a verifiable submitted receipt", [{
        kind: "submission_unverified", action: "manual_review"
      }]);
    }
    return body.receipt;
  }
}
