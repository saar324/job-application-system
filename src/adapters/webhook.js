import { NeedsInputError, NeedsReviewError } from "./errors.js";

export class WebhookAdapter {
  name = "webhook";
  constructor({ url, token }) {
    if (!url) throw new Error("APPLICATION_WEBHOOK_URL is required for the webhook adapter");
    this.url = url;
    this.token = token;
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
      throw new NeedsReviewError(`The application worker response was lost: ${error.message}`, [{
        kind: "submission_unverified", action: "manual_review",
        message: "Check whether the application was received before retrying"
      }]);
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 409 && body.status === "needs_input") {
      throw new NeedsInputError(body.message ?? "The application worker needs input", body.requirements ?? []);
    }
    if (response.status === 409 && body.status === "needs_human") {
      throw new NeedsReviewError(body.message ?? "The application worker needs human review", body.requirements ?? []);
    }
    if (response.status >= 500) {
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
