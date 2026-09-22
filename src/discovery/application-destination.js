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
