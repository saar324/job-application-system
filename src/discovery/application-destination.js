import { officialAtsIdentityFromUrl } from "./official-ats.js";

export function needsEmployerApplyUrl(value, boardHost) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === boardHost || hostname.endsWith(`.${boardHost}`);
  } catch { return true; }
}

const BOARD_REDIRECTS = {
  arbeitnow(opportunity) {
    return `${String(opportunity.listingUrl).replace(/\/$/, "")}/apply`;
  },
  remoteok(opportunity) {
    return `https://remoteok.com/l/${encodeURIComponent(opportunity.externalId)}`;
  }
};

const BOARD_HOSTS = new Set(["arbeitnow.com", "www.arbeitnow.com", "remoteok.com", "www.remoteok.com"]);
const AGGREGATOR_HOSTS = {
  himalayas: new Set(["himalayas.app", "www.himalayas.app"]),
  jobicy: new Set(["jobicy.com", "www.jobicy.com"])
};

// A board link is only a hint. Follow a few HTTPS redirects on that board,
// then require a fresh official ATS fetch before promoting any destination.
// Never fetch an arbitrary off-board website from an aggregator row.
export async function officialAtsUrlFromAggregator(opportunity, fetchImpl = fetch) {
  let current;
  try { current = new URL(opportunity.applyUrl); } catch { return { reason: "invalid_url" }; }
  if (current.protocol !== "https:" || current.username || current.password) {
    return { reason: "invalid_url" };
  }
  const hosts = AGGREGATOR_HOSTS[opportunity.source];
  if (!hosts) return { reason: "unsupported_source" };
  for (let hop = 0; hop <= 3; hop += 1) {
    const identity = officialAtsIdentityFromUrl(current.href);
    if (identity) return { url: current.href, identity };
    if (!hosts.has(current.hostname.toLowerCase())) return { reason: "non_ats_destination" };
    if (hop === 3) return { reason: "redirect_cap" };
    const response = await fetchImpl(current.href, {
      method: "HEAD", redirect: "manual",
      headers: { "user-agent": "job-application-server/0.2 (+private personal use)" },
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 403 || response.status === 429) {
      return { reason: `http_${response.status}` };
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { reason: "non_redirecting_board_link" };
    }
    const location = response.headers.get("location");
    if (!location) return { reason: "redirect_without_location" };
    try { current = new URL(location, current); } catch { return { reason: "invalid_redirect" }; }
    if (current.protocol !== "https:" || current.username || current.password) {
      return { reason: "invalid_redirect" };
    }
  }
  return { reason: "redirect_cap" };
}

export async function resolveEmployerApplicationUrl(opportunity, fetchImpl = fetch) {
  const build = BOARD_REDIRECTS[opportunity.source];
  if (!opportunity.applicationDestinationPending || !build) return opportunity;
  let current = new URL(build(opportunity));
  for (let hop = 0; hop < 3; hop += 1) {
    if (!BOARD_HOSTS.has(current.hostname.toLowerCase())) {
      return { ...opportunity, applyUrl: current.href, applicationDestinationPending: false,
        applicationDestinationResolvedFrom: opportunity.listingUrl };
    }
    const response = await fetchImpl(current, {
      method: "HEAD", redirect: "manual",
      headers: { "user-agent": "job-application-server/0.2 (+private personal use)" },
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status < 300 || response.status >= 400) return opportunity;
    const location = response.headers.get("location");
    if (!location) return opportunity;
    current = new URL(location, current);
    if (current.protocol !== "https:") return opportunity;
  }
  return opportunity;
}
