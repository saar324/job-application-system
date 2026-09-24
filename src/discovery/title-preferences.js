function normalizedWords(value) {
  const title = String(value ?? "").toLowerCase()
    .replace(/\bfull[\s-]?stack\b/g, "fullstack")
    .replace(/\bback[\s-]?end\b/g, "backend")
    .replace(/\bfront[\s-]?end\b/g, "frontend")
    .replace(/\bmachine[\s-]+learning\b/g, "ml")
    .replace(/\bartificial[\s-]+intelligence\b/g, "ai");
  const words = new Set(title.match(/[a-z0-9+#.]{2,}/g) ?? []);
  // Equivalent occupation nouns still need the other configured title words
  // to match. A one-word preference stays exact to avoid broad promotion.
  if (words.size >= 2 && (words.has("engineer") || words.has("developer"))) {
    words.delete("engineer");
    words.delete("developer");
    words.add("software_role");
  }
  return words;
}

// This is deliberately a small positive vocabulary. It helps distinguish a
// software role from a sales or physical-engineering occupation, but does not
// grant title priority or override any eligibility gate on its own.
const SOFTWARE_OCCUPATIONS = [
  /\b(?:software|fullstack|backend|frontend|web|mobile|platform|devops|site reliability|sre|product|ai|ml|machine learning|artificial intelligence)\s+(?:software\s+)?(?:engineer|developer|architect|scientist|programmer)\b/i,
  /\b(?:engineer|developer|architect|scientist|programmer)\s+(?:[,/-]\s*)?(?:software|fullstack|backend|frontend|ai|ml|machine learning)\b/i
];

function normalizedOccupationTitle(title) {
  return String(title ?? "").toLowerCase()
    .replace(/\bfull[\s-]?stack\b/g, "fullstack")
    .replace(/\bback[\s-]?end\b/g, "backend")
    .replace(/\bfront[\s-]?end\b/g, "frontend");
}

function firstMatchPosition(value, patterns) {
  return Math.min(...patterns.map((pattern) => value.search(pattern))
    .filter((position) => position >= 0), Infinity);
}

export function broadSoftwareRoleTitle(title) {
  return Number.isFinite(firstMatchPosition(normalizedOccupationTitle(title), SOFTWARE_OCCUPATIONS));
}

const UNRELATED_OCCUPATIONS = [
  /\b(?:account executive|account manager|sales (?:engineer|representative|manager|executive)|business development representative)\b/i,
  /\b(?:marketing (?:engineer|manager|specialist)|customer success (?:engineer|manager|representative)|recruiter|talent acquisition)\b/i,
  /\b(?:product manager|project manager|program manager|scrum master)\b/i,
  /\b(?:mechanical|civil|chemical|electrical|industrial|structural|manufacturing|hardware) engineer\b/i,
  /\b(?:nurse|physician|teacher|chef|electrician|warehouse operator)\b/i
];

export function unrelatedOccupationTitle(title) {
  const value = normalizedOccupationTitle(title);
  const unrelatedAt = firstMatchPosition(value, UNRELATED_OCCUPATIONS);
  if (!Number.isFinite(unrelatedAt)) return false;
  // The leading occupation names the job. A later software term may describe
  // the product sold or supported without turning a sales job into engineering.
  const softwareAt = firstMatchPosition(value, SOFTWARE_OCCUPATIONS);
  return unrelatedAt <= softwareAt;
}

function matchesConfiguredTitle(title, configuredTitle) {
  const titleWords = normalizedWords(title);
  const configuredWords = [...normalizedWords(configuredTitle)];
  return configuredWords.length > 0 && configuredWords.every((word) => titleWords.has(word));
}

export function preferredTitleGroups(profile) {
  const preferences = profile?.preferences?.fullTime ?? {};
  return {
    primary: preferences.jobTitles ?? [],
    secondary: preferences.secondaryJobTitles ?? []
  };
}

// Up to eight primary and four secondary preferred titles, deduplicated, used
// as provider search terms by sources that need a keyword.
export function profileSearchTerms(profile) {
  const groups = preferredTitleGroups(profile);
  const preferred = groups.primary.length
    ? groups.primary
    : profile?.preferences?.jobTitles ?? [];
  const primaryValues = [...preferred]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
  const primary = [...new Map(primaryValues.map((value) => [value.toLowerCase(), value])).values()].slice(0, 8);
  const secondary = groups.secondary
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()).slice(0, 4);
  return [...new Map([...primary, ...secondary].map((value) => [value.toLowerCase(), value])).values()];
}

export function configuredTitlePriority(title, profile) {
  const groups = preferredTitleGroups(profile);
  if (groups.primary.some((candidate) => matchesConfiguredTitle(title, candidate))) return "primary";
  if (groups.secondary.some((candidate) => matchesConfiguredTitle(title, candidate))) return "secondary";
  return undefined;
}

export function discoveryTitleRelevant(title, profile) {
  const preferences = profile?.preferences?.fullTime ?? {};
  if ((preferences.excludedTitles ?? []).some((candidate) => matchesConfiguredTitle(title, candidate))) return false;
  return Boolean(configuredTitlePriority(title, profile));
}

// Preserve the pre-broadening ATS title gate for staged rollout. This is a
// retrieval baseline only: it never grants fit or submission authority.
export function legacyDiscoveryTitleRelevant(title, profile) {
  const words = (value) => new Set(String(value ?? "").toLowerCase()
    .match(/[a-z0-9+#.]{2,}/g) ?? []);
  const preferences = profile?.preferences?.fullTime ?? {};
  const matches = (candidate) => {
    const titleWords = words(title);
    const configured = [...words(candidate)];
    return configured.length > 0 && configured.every((word) => titleWords.has(word));
  };
  return !(preferences.excludedTitles ?? []).some(matches)
    && [...(preferences.jobTitles ?? []), ...(preferences.secondaryJobTitles ?? [])].some(matches);
}
