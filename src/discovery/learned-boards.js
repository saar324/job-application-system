import { officialAtsIdentityFromUrl } from "./official-ats.js";

const SOURCE_KEYS = { ashby: ["boards", "slug"], greenhouse: ["boards", "token"],
  lever: ["sites", "slug"] };
const MAX_LEARNED_BOARDS = 5;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const CURATED_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const MAX_LEARNED_BOARD_REQUESTS_PER_DAY = 2;

export function learnedBoardRequestsInLastDay(audit, profileId, key, now = Date.now()) {
  return (audit ?? []).filter((event) => event.profileId === profileId
    && event.action === "discovery.ats_learned_board_request" && event.subjectId === key
    && Number.isFinite(Date.parse(event.at)) && now >= Date.parse(event.at)
    && now - Date.parse(event.at) < 24 * 60 * 60_000).length;
}

export function isLearnedBoardRequest(sourceId, rawUrl, boardKeys) {
  if (!boardKeys?.size) return null;
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const rules = {
    ashby: ["api.ashbyhq.com", /^\/posting-api\/job-board\/([a-z0-9_-]{1,100})\/?$/i],
    greenhouse: ["boards-api.greenhouse.io", /^\/v1\/boards\/([a-z0-9_-]{1,100})\/jobs\/?$/i],
    lever: ["api.lever.co", /^\/v0\/postings\/([a-z0-9_-]{1,100})\/?$/i]
  };
  const rule = rules[sourceId];
  if (!rule || url.hostname !== rule[0]) return null;
  const board = rule[1].exec(url.pathname)?.[1]?.toLowerCase();
  const key = board && `${sourceId}:${board}`;
  return key && boardKeys.has(key) ? key : null;
}

// A recently verified role can introduce its employer board to later scans
// for this profile. This never makes a future posting eligible by itself: the
// normal role scorer and official destination checks still run for every row.
export function sourceConfigWithLearnedBoards(state, profileId, sourceId, configured = {},
  { now = Date.now(), cycle = 0, isBackedOff = () => false,
    isAtRequestBudget = () => false } = {}) {
  const definition = SOURCE_KEYS[sourceId];
  if (!definition) return configured;
  const [listKey, boardKey] = definition;
  const configuredBase = configured[listKey] ?? [];
  if (!Array.isArray(configuredBase)) return configured;
  const base = configuredBase.filter((item) => !isBackedOff(`${sourceId}:${item?.[boardKey]}`));
  const seen = new Set(base.map((item) => String(item?.[boardKey] ?? "").toLowerCase()));
  const recent = (state?.opportunities ?? []).filter((item) => item.profileId === profileId
    && item.applicationDestinationVerified === true
    && item.applicationDestinationPending !== true
    && item.discoveryVerification?.sourceId === sourceId
    && Number(item.score ?? 0) >= 60
    && Number.isFinite(Date.parse(item.discoveryVerification.verifiedAt))
    && now - Date.parse(item.discoveryVerification.verifiedAt) <= MAX_AGE_MS
    && now >= Date.parse(item.discoveryVerification.verifiedAt))
    .map((item) => ({ item, verifiedAt: item.discoveryVerification.verifiedAt,
      provenance: "current_official_role" }));
  const opportunityById = new Map((state?.opportunities ?? [])
    .filter((item) => item.profileId === profileId).map((item) => [item.id, item]));
  const submitted = (state?.applications ?? []).filter((application) => {
    const submittedAt = Date.parse(application.receipt?.submittedAt);
    return application.profileId === profileId && application.status === "submitted"
      && application.receipt?.simulated !== true && Number.isFinite(submittedAt)
      && now >= submittedAt && now - submittedAt <= MAX_AGE_MS;
  }).map((application) => ({ item: opportunityById.get(application.opportunityId),
    verifiedAt: application.receipt.submittedAt, provenance: "verified_submission_receipt" }))
    .filter(({ item }) => item && item.applicationDestinationPending !== true);
  // Owner-curated seeds live only in the private server configuration. An
  // official role URL, profile scope and recent review date are all required.
  // The listing fetch still determines whether any role is currently open.
  const curated = (Array.isArray(configured.ownerCuratedBoards)
    ? configured.ownerCuratedBoards : []).filter((seed) => {
    if (seed?.profileId !== profileId || seed.enabled === false) return false;
    const reviewedAt = Date.parse(seed.reviewedAt);
    return Number.isFinite(reviewedAt) && now >= reviewedAt
      && now - reviewedAt <= CURATED_MAX_AGE_MS;
  }).map((seed) => ({ seed, parsed: officialAtsIdentityFromUrl(seed.officialRoleUrl),
    verifiedAt: seed.reviewedAt, provenance: "owner_curated_official_role" }))
    .filter(({ parsed }) => parsed?.source === sourceId);
  const candidates = [...curated, ...recent, ...submitted]
    .sort((left, right) => Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt));
  const eligible = [];
  for (const candidate of candidates) {
    const parsed = candidate.parsed ?? officialAtsIdentityFromUrl(candidate.item.applyUrl);
    const normalizedBoard = parsed?.board?.toLowerCase();
    if (parsed?.source !== sourceId || !normalizedBoard || seen.has(normalizedBoard)
      || isBackedOff(`${sourceId}:${parsed.board}`)
      || isAtRequestBudget(`${sourceId}:${normalizedBoard}`)
      || configured.disabledBoardKeys?.includes(`${sourceId}:${normalizedBoard}`)) continue;
    seen.add(normalizedBoard);
    eligible.push({ [boardKey]: parsed.board,
      company: String(candidate.seed?.company ?? candidate.item?.company ?? parsed.board).slice(0, 200),
      seedProvenance: candidate.provenance, seedVerifiedAt: candidate.verifiedAt,
      seedProfileId: profileId });
  }
  const learned = [];
  if (eligible.length) {
    const ordinal = Number.isInteger(cycle) && cycle >= 0 ? cycle : 0;
    const start = (ordinal * MAX_LEARNED_BOARDS) % eligible.length;
    for (let offset = 0; offset < Math.min(MAX_LEARNED_BOARDS, eligible.length); offset += 1) {
      learned.push(eligible[(start + offset) % eligible.length]);
    }
  }
  return learned.length || base.length !== configuredBase.length
    ? { ...configured, [listKey]: [...base, ...learned] } : configured;
}
