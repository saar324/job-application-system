// A role may enter the system through a board feed, a direct application URL,
// or an indexed listing. Match stable ATS IDs before falling back to URLs.
// Company and title are useful review hints, but are not role identities.
const TRACKING_PARAMETER = /^(utm_|ref$|refid$|trackingid$|source$|gh_src$|lever-source$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identityText(value) {
  return String(value ?? '').toLowerCase().replace(/&amp;/g, ' and ')
    .replace(/[^a-z0-9+#.]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function keyFromUrl(raw) {
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  if (['job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io',
    'boards.greenhouse.io', 'boards.eu.greenhouse.io'].includes(host)) {
    const offset = parts[0]?.toLowerCase() === 'boards' ? 1 : 0;
    if (parts[offset] && parts[offset + 1]?.toLowerCase() === 'jobs' && /^\d+$/.test(parts[offset + 2] ?? '')) {
      return `greenhouse:${parts[offset].toLowerCase()}:${parts[offset + 2]}`;
    }
  }
  if (host === 'jobs.ashbyhq.com' && parts[0] && UUID.test(parts[1] ?? '')) {
    return `ashby:${parts[0].toLowerCase()}:${parts[1].toLowerCase()}`;
  }
  if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(host) && parts[0] && UUID.test(parts[1] ?? '')) {
    return `lever:${parts[0].toLowerCase()}:${parts[1].toLowerCase()}`;
  }
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETER.test(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  url.pathname = `/${parts.filter((part, index) => index < parts.length - 1
    || !['apply', 'application', 'confirmation'].includes(part.toLowerCase())).join('/')}`;
  return `url:${url.toString().replace(/\/$/, '')}`;
}

export function roleKeys(role) {
  const keys = new Set();
  const source = String(role?.source ?? '').toLowerCase();
  const externalId = String(role?.externalId ?? '');
  if (['ashby', 'greenhouse', 'lever'].includes(source)) {
    const separator = externalId.lastIndexOf(':');
    if (separator > 0) {
      const board = externalId.slice(0, separator).toLowerCase();
      const id = externalId.slice(separator + 1).toLowerCase();
      if (board && (source === 'greenhouse' ? /^\d+$/.test(id) : UUID.test(id))) {
        keys.add(`${source}:${board}:${id}`);
      }
    }
  }
  for (const raw of [role?.applyUrl, role?.listingUrl, role?.url]) {
    const key = keyFromUrl(raw);
    if (key) keys.add(key);
  }
  const official = [...keys].filter((key) => /^(ashby|greenhouse|lever):/.test(key));
  return official.length ? new Set(official) : keys;
}

export function roleSimilarityKey(role) {
  const company = identityText(role?.company);
  const title = identityText(role?.title);
  return company && title && title !== "direct application" ? `role:${company}:${title}` : null;
}

// Only an official ATS identity proves that two same-title URLs name separate
// openings. Distinct aggregator URLs do not establish that fact.
export function relatedApplicationRole(state, profileId, candidate, excludeApplicationId) {
  const similarity = roleSimilarityKey(candidate);
  const candidateKeys = roleKeys(candidate);
  const candidateOfficial = [...candidateKeys].filter((key) => /^(ashby|greenhouse|lever):/.test(key));
  const opportunities = new Map((state.opportunities ?? [])
    .filter((item) => item.profileId === profileId).map((item) => [item.id, item]));
  for (const application of state.applications ?? []) {
    if (application.profileId !== profileId || application.id === excludeApplicationId) continue;
    if (["skipped", "rejected", "failed"].includes(application.status)
      && !application.receipt?.submittedAt
      && application.finalSubmissionDecision?.status !== "consumed") continue;
    const previous = opportunities.get(application.opportunityId);
    if (!previous) continue;
    const previousKeys = new Set(roleKeys(previous));
    if (application.receipt?.finalUrl) {
      for (const key of roleKeys({ applyUrl: application.receipt.finalUrl })) previousKeys.add(key);
    }
    const previousOfficial = [...previousKeys].filter((key) => /^(ashby|greenhouse|lever):/.test(key));
    if (candidateOfficial.length && previousOfficial.length
      && !candidateOfficial.some((key) => previousOfficial.includes(key))) continue;
    if ([...candidateKeys].some((key) => previousKeys.has(key))) return "same_role";
    if (!similarity || similarity !== roleSimilarityKey(previous)) continue;
    if (candidateOfficial.length && previousOfficial.length) continue;
    return "possible_duplicate";
  }
  return null;
}

export function handledRoleIndex(state, profileId) {
  const opportunities = new Map((state.opportunities ?? [])
    .filter((item) => item.profileId === profileId).map((item) => [item.id, item]));
  const keys = new Set();
  for (const application of state.applications ?? []) {
    if (application.profileId !== profileId) continue;
    const opportunity = opportunities.get(application.opportunityId);
    if (!opportunity) continue;
    for (const key of roleKeys(opportunity)) keys.add(key);
    if (application.receipt?.finalUrl) {
      for (const key of roleKeys({ applyUrl: application.receipt.finalUrl })) keys.add(key);
    }
  }
  return keys;
}

export function knownRoleIndex(state, profileId) {
  const keys = new Set();
  const applicationsByOpportunity = new Map();
  for (const application of state.applications ?? []) {
    if (application.profileId !== profileId) continue;
    const rows = applicationsByOpportunity.get(application.opportunityId) ?? [];
    rows.push(application); applicationsByOpportunity.set(application.opportunityId, rows);
  }
  for (const opportunity of state.opportunities ?? []) {
    if (opportunity.profileId !== profileId) continue;
    const applications = applicationsByOpportunity.get(opportunity.id) ?? [];
    // An unresolved board listing is observed, not handled. Revisit it so a
    // later scan can resolve its employer destination or update its evidence.
    if ((opportunity.applicationDestinationPending === true
      || opportunity.applicationDestinationVerified !== true)
      && !applications.length) continue;
    // A confirmed unavailable posting may reopen later. Its skipped attempt
    // carried no final action, so a fresh employer check is safe; receipts and
    // uncertain final actions remain handled regardless of lead state.
    if (opportunity.discoveryState === "closed"
      && opportunity.closedOrigin === "posting_unavailable"
      && applications.every((application) =>
      application.status === "skipped" && !application.receipt?.submittedAt
      && application.finalSubmissionDecision?.status !== "consumed")) continue;
    for (const key of roleKeys(opportunity)) keys.add(key);
  }
  for (const application of state.applications ?? []) {
    if (application.profileId !== profileId || !application.receipt?.finalUrl) continue;
    for (const key of roleKeys({ applyUrl: application.receipt.finalUrl })) keys.add(key);
  }
  return keys;
}

export function isHandledRole(role, handledKeys) {
  return [...roleKeys(role)].some((key) => handledKeys.has(key));
}
