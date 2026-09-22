import path from "node:path";
import { automateApplication } from "./automation.js";

export async function executeInFreshContext({ browser, payload, urlPolicy, artifactsDirectory,
  automate = automateApplication, adaptiveController, draftProvider, egressProxy, markFinalActionStarted }) {
  const initialHostname = new URL(payload.opportunity.applyUrl).hostname.toLowerCase();
  const requestDomains = payload.opportunity.userRequested === true ? [initialHostname] : [];
  try {
    urlPolicy.assertAllowed(payload.opportunity.applyUrl, requestDomains);
    await urlPolicy.assertPublic(payload.opportunity.applyUrl);
  } catch (error) {
    return {
      status: "needs_human", message: "The application destination was blocked by security policy",
      requirements: [{ kind: "blocked_destination", action: "manual_review", message: error.message }]
    };
  }

  const context = await browser.newContext({ acceptDownloads: false,
    ...(egressProxy ? { proxy: { server: egressProxy.url } } : {}) });
  let blockedRequest;
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    try {
      if (/^https?:/i.test(requestUrl)) await urlPolicy.assertPublic(requestUrl);
      if (route.request().isNavigationRequest()) urlPolicy.assertAllowed(requestUrl, requestDomains);
      else if (/^https?:/i.test(requestUrl)) urlPolicy.assertNetworkSafe(requestUrl);
      await route.continue();
    } catch (error) {
      let hostname = "unknown";
      try { hostname = new URL(requestUrl).hostname; } catch {}
      blockedRequest = { hostname, code: error.code ?? "destination_policy_denied", message: error.message };
      await route.abort("blockedbyclient");
    }
  });
  const page = await context.newPage();
  try {
    try {
      const result = await automate({
        page, profile: payload.profile, opportunity: payload.opportunity, application: payload.application,
        evidencePacket: payload.evidencePacket, draftProvider, markFinalActionStarted,
        artifactsDirectory: path.join(artifactsDirectory, payload.profile.id)
      });
      if (result.status === "needs_human"
        && result.requirements?.some((item) => item.kind === "unsupported_form")
        && adaptiveController?.canRun?.(payload)) {
        return adaptiveController.execute({
          page, profile: payload.profile, opportunity: payload.opportunity, application: payload.application,
          artifactsDirectory: path.join(artifactsDirectory, payload.profile.id)
        });
      }
      return result;
    } catch (error) {
      if (!blockedRequest) throw error;
      return {
        status: "needs_human", message: "The application attempted to open a blocked destination",
        requirements: [{ kind: "blocked_destination", action: "manual_review",
          message: blockedRequest.message, hostname: blockedRequest.hostname, reasonCode: blockedRequest.code }]
      };
    }
  } finally {
    await context.close();
  }
}
