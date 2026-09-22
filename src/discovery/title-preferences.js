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
