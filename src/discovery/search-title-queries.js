import { preferredTitleGroups } from "./title-preferences.js";

const SEARCHABLE_ROLE = /\b(engineer|developer|scientist|architect)\b/i;
const SOFTWARE_INTENT = /\b(engineer|developer|scientist|architect|software|full[\s-]?stack|back[\s-]?end|front[\s-]?end|devops|sre)\b/i;
const BROAD_PROBES = ["software", "developer", "engineer"];

function normalized(title) {
  return String(title ?? "").toLowerCase()
    .replace(/\bfull[\s-]?stack\b/g, "fullstack")
    .replace(/\bback[\s-]?end\b/g, "backend")
    .replace(/\bfront[\s-]?end\b/g, "frontend")
    .replace(/[-–—]/g, " ").replace(/\s+/g, " ").trim();
}

function historyFamily(title) {
  const words = normalized(title).match(/[a-z0-9+#.]+/g) ?? [];
  const roleIndex = words.findIndex((word) => /^(engineer|developer|scientist|architect)$/.test(word));
  if (roleIndex < 1 || roleIndex > 6) return null;
  const modifiers = new Set(["senior", "sr", "junior", "jr", "mid", "lead", "staff",
    "principal", "remote", "midlevel", "level"]);
  const family = words.slice(0, roleIndex + 1).filter((word) => !modifiers.has(word));
  if (family.length < 2 || family.length > 5) return null;
  return family.map((word) => ["ai", "ml"].includes(word)
    ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)).join(" ");
}

function lexicalVariants(title) {
  const variants = [];
  const words = normalized(title).match(/[a-z0-9]+/g) ?? [];
  const distinctive = words.some((word) => !["engineer", "developer", "senior", "junior",
    "lead", "staff", "principal", "mid", "remote"].includes(word));
  if (distinctive && /\bengineer\b/i.test(title)) {
    variants.push(title.replace(/\bengineer\b/i, "Developer"));
  }
  if (distinctive && /\bdeveloper\b/i.test(title)) {
    variants.push(title.replace(/\bdeveloper\b/i, "Engineer"));
  }
  if (/\b(?:AI|ML)\b/.test(title)) {
    variants.push(title.replace(/\b(?:AI|ML)\b/, "Machine Learning"));
  }
  return variants;
}

/**
 * Produce a bounded lexical plan. `cycle` is a durable, zero-based per-profile
 * campaign ordinal supplied by the caller, not a random campaign identifier.
 * A software-role plan reserves a broad probe. Three-phase ordering covers
 * up to three times the remaining specific slots in three cycles.
 */
export function searchTitleQueryPlan(profile, submittedTitles = [], { maximum = 16,
  cycle = 0 } = {}) {
  const cap = Number.isInteger(maximum) ? Math.max(0, Math.min(16, maximum)) : 16;
  const phase = Number.isInteger(cycle) && cycle >= 0 ? cycle % 3 : 0;
  const groups = preferredTitleGroups(profile);
  const preferred = groups.primary.length ? groups.primary : profile?.preferences?.jobTitles ?? [];
  const configured = [];
  const configuredSeen = new Set();
  for (const [origin, titles] of [["primary", preferred], ["secondary", groups.secondary]]) {
    for (const value of titles) {
      if (typeof value !== "string" || !value.trim()) continue;
      const key = normalized(value);
      if (!key || configuredSeen.has(key)) continue;
      configuredSeen.add(key);
      configured.push({ term: value.trim(), origin, roleFamily: key });
    }
  }
  const historyCounts = new Map();
  for (const title of submittedTitles) {
    if (typeof title !== "string" || !SEARCHABLE_ROLE.test(title)) continue;
    const family = historyFamily(title);
    if (!family) continue;
    const key = normalized(family);
    const item = historyCounts.get(key) ?? { term: family, origin: "verified_history",
      roleFamily: key, count: 0 };
    item.count += 1;
    historyCounts.set(key, item);
  }
  const history = [...historyCounts.values()].sort((a, b) => b.count - a.count)
    .slice(0, 4);
  const queries = [];
  const seen = new Set();
  const softwareIntent = [...configured, ...history].some((item) => SOFTWARE_INTENT.test(item.term));
  const specificLimit = Math.max(0, cap - (softwareIntent ? 1 : 0));
  function add(item) {
    const key = normalized(item.term);
    if (!key || seen.has(key) || queries.length >= specificLimit) return false;
    seen.add(key);
    queries.push({ term: item.term, origin: item.origin, roleFamily: item.roleFamily });
    return true;
  }
  const ordered = [...configured.filter((_, index) => index % 3 === phase),
    ...configured.filter((_, index) => index % 3 !== phase)];
  for (const item of ordered) add(item);
  for (const item of history) add(item);
  const variants = queries.flatMap((item) => lexicalVariants(item.term).map((term) => ({
    term, origin: "lexical_variant", roleFamily: item.roleFamily
  })));
  for (const item of variants) add(item);
  const broad = cap > 0 && softwareIntent
    ? BROAD_PROBES.slice(phase).concat(BROAD_PROBES.slice(0, phase))
      .find((term) => !seen.has(normalized(term))) : null;
  if (broad) queries.push({ term: broad, origin: "broad_probe", roleFamily: "software" });
  const selected = new Set(queries.map((item) => normalized(item.term)));
  const coverageBlocked = configured.length > 3 * specificLimit;
  const skippedTerms = [...configured, ...history, ...variants]
    .filter((item) => !selected.has(normalized(item.term)))
    .map((item) => ({ term: item.term, origin: item.origin,
      reason: item.origin === "lexical_variant" || item.origin === "verified_history"
        ? "query_budget" : coverageBlocked ? "three_cycle_budget" : "cycle_rotation" }));
  return { queries, skippedTerms, broadProbe: broad, cycle: phase,
    configuredFamilyCount: configured.length, coverageBlocked };
}

export function searchTitleQueries(profile, submittedTitles = [], maximum = 16, options = {}) {
  return searchTitleQueryPlan(profile, submittedTitles, { maximum, ...options })
    .queries.map((item) => item.term);
}
