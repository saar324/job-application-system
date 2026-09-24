import { roleKeys } from "./handled-roles.js";
import { officialAtsIdentityFromUrl } from "./official-ats.js";

export const PENDING_RETRY_MS = 30 * 60_000;
export const PENDING_TTL_MS = 7 * 24 * 60 * 60_000;
export const CLOSED_RETRY_MS = 24 * 60 * 60_000;

export function matchingStoredLead(state, profileId, candidate) {
  const keys = roleKeys(candidate);
  return state.opportunities.find((item) => item.profileId === profileId
    && (item.source === candidate.source && item.externalId && item.externalId === candidate.externalId
      || [...roleKeys(item)].some((key) => keys.has(key))));
}

export function leadRetryDecision(item, candidate, at = Date.now()) {
  if (!item) return null;
  if (item.discoveryState === "closed" && item.closedOrigin === "posting_unavailable") {
    return Date.parse(item.closedRetryAfter ?? "") > at ? "closed_backoff" : null;
  }
  const pending = item.discoveryState === "pending_destination"
    || item.applicationDestinationPending === true;
  if (!pending && item.discoveryState !== "expired") return null;
  // A fresh strong ATS link can establish that an older unresolved lead is
  // open. An unverified board link cannot revive an expired observation.
  const official = officialAtsIdentityFromUrl(candidate.applyUrl);
  if (official && candidate.source === official.source
    && String(candidate.externalId ?? "").toLowerCase() === `${official.board}:${official.id}`) return null;
  const first = Date.parse(item.destinationFirstObservedAt ?? item.createdAt ?? "");
  if (item.discoveryState === "expired"
    || Number.isFinite(first) && first + PENDING_TTL_MS <= at) return "pending_expired";
  return Date.parse(item.destinationRetryAfter ?? "") > at ? "pending_backoff" : null;
}

export function retryDelay(base, attempt, maximum) {
  return Math.min(maximum, base * 2 ** Math.min(8, Math.max(0, attempt - 1)));
}
