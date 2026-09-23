// A role may enter the system through a board feed, a direct application URL,
// or an indexed listing. Match stable ATS IDs before falling back to URLs.
const TRACKING_PARAMETER = /^(utm_|ref$|refid$|trackingid$|source$|gh_src$|lever-source$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  return keys;
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
  }
  return keys;
}

export function knownRoleIndex(state, profileId) {
  const keys = new Set();
  for (const opportunity of state.opportunities ?? []) {
    if (opportunity.profileId !== profileId) continue;
    for (const key of roleKeys(opportunity)) keys.add(key);
  }
  return keys;
}

export function isHandledRole(role, handledKeys) {
  return [...roleKeys(role)].some((key) => handledKeys.has(key));
}
