import path from "node:path";
import { automateApplication } from "./automation.js";

export async function executeInFreshContext({ browser, payload, urlPolicy, artifactsDirectory, automate = automateApplication }) {
  const requestedDomains = payload.opportunity.userRequested
    ? [new URL(payload.opportunity.applyUrl).hostname] : [];
  try {
    urlPolicy.assertAllowed(payload.opportunity.applyUrl, requestedDomains);
    await urlPolicy.assertPublic(payload.opportunity.applyUrl);
  } catch (error) {
    return {
      status: "needs_human", message: "The application destination was blocked by security policy",
      requirements: [{ kind: "blocked_destination", action: "manual_review", message: error.message }]
    };
  }

  const context = await browser.newContext({ acceptDownloads: false });
  let blockedRequest;
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    try {
      if (/^https?:/i.test(requestUrl)) await urlPolicy.assertPublic(requestUrl);
      if (route.request().isNavigationRequest()) urlPolicy.assertAllowed(requestUrl, requestedDomains);
      else if (/^https?:/i.test(requestUrl)) urlPolicy.assertNetworkSafe(requestUrl);
      await route.continue();
    } catch (error) {
      blockedRequest = { url: requestUrl, message: error.message };
      await route.abort("blockedbyclient");
    }
  });
  const page = await context.newPage();
  try {
    try {
      return await automate({
        page, profile: payload.profile, opportunity: payload.opportunity, application: payload.application,
        artifactsDirectory: path.join(artifactsDirectory, payload.profile.id)
      });
    } catch (error) {
      if (!blockedRequest) throw error;
      return {
        status: "needs_human", message: "The application attempted to open a blocked destination",
        requirements: [{ kind: "blocked_destination", action: "manual_review",
          message: blockedRequest.message, url: blockedRequest.url }]
      };
    }
  } finally {
    await context.close();
  }
}
