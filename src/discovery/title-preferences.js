function normalizedWords(value) {
  return new Set(String(value ?? "").toLowerCase().match(/[a-z0-9+#.]{2,}/g) ?? []);
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
