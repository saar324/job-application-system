import { configuredTitlePriority, preferredTitleGroups,
  unrelatedOccupationTitle } from "./title-preferences.js";
import { matchSkills } from "./skills.js";

function words(value) {
  return new Set(String(value ?? "").toLowerCase().match(/[a-z0-9+#.]{2,}/g) ?? []);
}

function includesPhrase(text, phrase) { return text.includes(String(phrase).toLowerCase()); }

const GLOBAL_REMOTE = /\b(worldwide|anywhere|global|all countries)\b/i;
const RESTRICTED_REMOTE = /\b(only|restricted|must be (?:based|located)|residents?|candidates? in|within)\b/i;
const REGIONAL_SCOPE = /\b(eu|eea|europe|european|emea)\b/i;
const COUNTRY_NAMES = [
  "albania", "andorra", "argentina", "australia", "austria", "belarus", "belgium", "bosnia",
  "brazil", "bulgaria", "canada", "chile", "china", "colombia", "croatia", "cyprus", "czechia",
  "denmark", "estonia", "finland", "france", "georgia", "germany", "greece", "hungary", "iceland",
  "india", "ireland", "israel", "italy", "japan", "latvia", "liechtenstein", "lithuania",
  "luxembourg", "malta", "mexico", "moldova", "monaco", "montenegro", "netherlands", "norway",
  "poland", "portugal", "romania", "serbia", "slovakia", "slovenia", "spain", "sweden",
  "switzerland", "turkey", "ukraine", "united kingdom", "united states", "usa"
];
const COUNTRY_CODES = new Map([
  ["albania", "AL"], ["andorra", "AD"], ["austria", "AT"], ["belarus", "BY"],
  ["belgium", "BE"], ["bosnia", "BA"], ["bulgaria", "BG"], ["croatia", "HR"],
  ["cyprus", "CY"], ["czechia", "CZ"], ["denmark", "DK"], ["estonia", "EE"],
  ["finland", "FI"], ["france", "FR"], ["germany", "DE"], ["greece", "GR"],
  ["hungary", "HU"], ["iceland", "IS"], ["ireland", "IE"], ["israel", "IL"],
  ["italy", "IT"], ["latvia", "LV"], ["liechtenstein", "LI"], ["lithuania", "LT"],
  ["luxembourg", "LU"], ["malta", "MT"], ["moldova", "MD"], ["monaco", "MC"],
  ["montenegro", "ME"], ["netherlands", "NL"], ["norway", "NO"], ["poland", "PL"],
  ["portugal", "PT"], ["romania", "RO"], ["serbia", "RS"], ["slovakia", "SK"],
  ["slovenia", "SI"], ["spain", "ES"], ["sweden", "SE"], ["switzerland", "CH"],
  ["turkey", "TR"], ["ukraine", "UA"], ["united kingdom", "GB"],
  ["canada", "CA"], ["united states", "US"], ["usa", "US"]
]);
const REGIONS = {
  us: /\b(us|u\.s\.|usa|united states|north america)\b/i,
  europe: /\b(eu|europe|european|emea|bulgaria|germany|france|spain|italy|netherlands|poland|romania|greece|portugal|austria|belgium|sweden|denmark|finland|ireland)\b/i,
  uk: /\b(uk|u\.k\.|united kingdom|britain|england|scotland|wales)\b/i,
  canada: /\b(canada|canadian)\b/i,
  asia: /\b(asia|apac|india|singapore|japan|china|philippines)\b/i,
  australia: /\b(australia|new zealand|anz)\b/i
};
const PERIOD_FACTORS = { year: 1, annual: 1, annually: 1, month: 12, monthly: 12, week: 52, weekly: 52, day: 260, daily: 260, hour: 2080, hourly: 2080 };

function normalizedEmployment(value) {
  const text = String(value ?? "").toLowerCase().replace(/[_-]+/g, " ").trim();
  if (/full\s*time|permanent/.test(text)) return "full_time";
  if (/part\s*time/.test(text)) return "part_time";
  if (/contract|contractor|freelance|temporary|temp\b/.test(text)) return "contract";
  if (/intern/.test(text)) return "internship";
  return text || undefined;
}

function normalizedCompensationBasis(value) {
  const text = String(value ?? "").toLowerCase().replace(/[_-]+/g, " ").trim();
  if (/\b(net|take home|after tax)\b/.test(text)) return "net";
  if (/\b(gross|before tax)\b/.test(text)) return "gross";
  return "unspecified";
}

function locationExclusion(opportunity, allowedLocations) {
  const location = String(opportunity.location ?? "").trim();
  if (!opportunity.remote || !location) return null;
  const lower = location.toLowerCase();
  const explicitCountries = COUNTRY_NAMES.filter((country) => includesPhrase(lower, country));
  const residenceCountries = COUNTRY_NAMES.filter((country) =>
    (allowedLocations ?? []).some((value) => includesPhrase(String(value).toLowerCase(), country)));
  const explicitCodes = new Set(location.match(/\b[A-Z]{2}\b/g) ?? []);
  const residenceCodes = new Set(residenceCountries.map((country) => COUNTRY_CODES.get(country)).filter(Boolean));
  const residenceIncluded = explicitCountries.some((country) => residenceCountries.includes(country))
    || [...residenceCodes].some((code) => explicitCodes.has(code));
  const namedRegions = Object.entries(REGIONS).filter(([, pattern]) => pattern.test(lower)).map(([name]) => name);
  // A list of named countries is a residence restriction, even when every
  // country in that list is part of a broad region accepted by the profile.
  if (explicitCountries.length && !REGIONAL_SCOPE.test(lower)
    && !residenceIncluded) {
    return `location restriction ${location} does not include the applicant residence`;
  }
  const locationQualifier = lower
    .replace(/\b(remote|distributed|work from home|locations?)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
  if (locationQualifier && !GLOBAL_REMOTE.test(lower) && !REGIONAL_SCOPE.test(lower)
    && !residenceIncluded) {
    return `location restriction ${location} does not include the applicant residence or an accepted region`;
  }
  if (residenceIncluded) return null;
  const globalOnly = GLOBAL_REMOTE.test(lower) && !explicitCountries.length
    && !namedRegions.length && !RESTRICTED_REMOTE.test(lower);
  if (globalOnly || (!explicitCountries.length && !namedRegions.length)) return null;

  const allowedText = allowedLocations.join(" ").toLowerCase();
  const allowedRegions = new Set(Object.entries(REGIONS)
    .filter(([, pattern]) => pattern.test(allowedText)).map(([name]) => name));
  if (namedRegions.some((region) => allowedRegions.has(region))) return null;
  return `location restriction ${location} does not match allowed locations`;
}

function excludedLocationReason(opportunity, excludedLocations, allowedLocations) {
  const location = String(opportunity.location ?? "").toLowerCase();
  if (!location) return null;
  const excluded = excludedLocations.find((value) => includesPhrase(location, value));
  if (!excluded) return null;
  // A comma-separated remote location is a set of hiring alternatives. An
  // excluded country in one alternative must not reject an accepted one.
  if (opportunity.remote && /[,;/|]|\s+or\s+/i.test(location)) {
    const alternatives = location.split(/[,;/|]|\s+or\s+/i).map((part) => part.trim());
    const namedAllowed = (allowedLocations ?? []).map((value) => String(value).toLowerCase())
      .filter((value) => value && !/^(remote|worldwide|anywhere|global|all countries)$/.test(value));
    const hasAllowedAlternative = alternatives.some((part) =>
      !includesPhrase(part, excluded) && namedAllowed.some((value) =>
        includesPhrase(part, value)
        || (COUNTRY_CODES.get(value) && part.toUpperCase() === COUNTRY_CODES.get(value))));
    if (hasAllowedAlternative) return null;
  }
  return `location ${opportunity.location} matches excluded location ${excluded}`;
}

function qualityExclusions(opportunity, profile, acceptedTypes, allowedLocations) {
  const title = String(opportunity.title ?? "");
  const description = String(opportunity.description ?? "");
  const answers = profile.applicationAnswers ?? {};
  const exclusions = [];
  const normalizedSkills = new Set((profile.skills ?? []).map((skill) =>
    String(skill).toLowerCase().replace(/[^a-z0-9+#.]+/g, "")));
  const coreTitleRequirements = [
    { pattern: /(?:^|\s)(?:c#|\.net)(?=\s|$)/i, skills: ["c#", ".net"], label: "C#/.NET" },
    { pattern: /\b(?:golang|go (?:developer|engineer))\b/i, skills: ["go", "golang"], label: "Go" },
    { pattern: /\bkotlin\b/i, skills: ["kotlin"], label: "Kotlin" },
    { pattern: /\bjava\b/i, skills: ["java"], label: "Java" },
    { pattern: /\bsvelte(?:kit)?\b/i, skills: ["svelte", "sveltekit"], label: "Svelte" }
  ];
  for (const requirement of coreTitleRequirements) {
    if (requirement.pattern.test(title)
      && !requirement.skills.some((skill) => normalizedSkills.has(skill))) {
      exclusions.push(`title requires ${requirement.label}, which is absent from the verified skill profile`);
      break;
    }
  }
  const explicitTechnologyRequirements = [...description.matchAll(
    /\b\d{1,2}\s*\+?\s*years?\s+(?:of\s+)?(?:hands-on\s+)?(?:experience\s+)?with\s+([A-Za-z][A-Za-z0-9.+#-]{1,30})\s+(?:in\s+)?production\b/gi
  )];
  for (const match of explicitTechnologyRequirements) {
    const technology = match[1];
    const normalized = technology.toLowerCase().replace(/[^a-z0-9+#.]+/g, "");
    if (!normalizedSkills.has(normalized)) {
      exclusions.push(`role requires production experience with ${technology}, which is absent from the verified skill profile`);
      break;
    }
  }
  if (/\bmust[- ]have\b[\s\S]{0,3000}\bproduction blockchain experience\b/i.test(description)
    && ![...normalizedSkills].some((skill) => /blockchain|crypto/.test(skill))) {
    exclusions.push("role requires production blockchain experience, which is absent from the verified skill profile");
  }
  const fluentLanguages = [...description.matchAll(/\bfluent\s+(?:in\s+)?(?:the\s+)?([A-Za-z]+)(?:\s+language)?\b/gi)]
    .map((match) => match[1]);
  for (const language of fluentLanguages) {
    const verified = answers[`${language[0].toUpperCase()}${language.slice(1).toLowerCase()} proficiency`];
    if (verified && /^(?:a1|a2|b1|b2|basic|elementary|intermediate)$/i.test(String(verified).trim())) {
      exclusions.push(`role requires fluent ${language}; verified proficiency is ${verified}`);
      break;
    }
  }
  if (acceptedTypes.length && !acceptedTypes.includes("contract")
    && /\b(?:contractor|contract)\s+(?:role|position|engagement)\b/i.test(description)) {
    exclusions.push("description identifies the opportunity as a contract role");
  }
  const cannotWorkUsHours = [answers["Can you work U.S. business hours?"],
    answers["Can you regularly overlap with Eastern Time?"], answers["Are you able to overlap with Eastern Time?"]]
    .some((value) => /^(?:no|false)$/i.test(String(value ?? "").trim()));
  if (cannotWorkUsHours
    && /\b(?:u\.?s\.?|united states|eastern|est|edt)\s+(?:business\s+)?(?:time|hours|timezone|time zone)\b/i.test(description)) {
    exclusions.push("role requires U.S. or Eastern Time hours that conflict with the verified schedule");
  }
  const verifiedYears = Number(answers["Years of professional software engineering experience"]
    ?? answers["Years of commercial software development experience"]);
  const requiredYears = [...description.matchAll(/\b(\d{1,2})\s*\+?\s*(?:or more )?years? of (?:professional )?(?:software engineering|software development|backend|back-end|frontend|front-end|full[- ]stack) experience\b/gi)]
    .map((match) => Number(match[1])).filter(Number.isFinite);
  if (Number.isFinite(verifiedYears) && requiredYears.length && Math.min(...requiredYears) > verifiedYears) {
    exclusions.push(`role requires ${Math.min(...requiredYears)} years of software experience; verified profile has ${verifiedYears}`);
  }
  const describedLocation = description.match(/\b(?:we can hire candidates|candidates? must be based|role is open to candidates)\s+(?:who are )?(?:based|located)?\s*(?:in|within)\s+([^.;\n]{2,240})/i)?.[1];
  if (describedLocation) {
    const reason = locationExclusion({ ...opportunity, location: describedLocation, remote: true }, allowedLocations);
    if (reason) exclusions.push(`description ${reason}`);
  }
  const titleLocation = title.match(/(?:remote\s*[@-]?\s*|\(remote\s+)([A-Za-z][A-Za-z ]{2,40})\)?\s*$/i)?.[1];
  if (titleLocation) {
    const reason = locationExclusion({ ...opportunity, location: titleLocation, remote: true }, allowedLocations);
    if (reason) exclusions.push(`title ${reason}`);
  }
  return exclusions;
}

// A missing skill-list entry is uncertainty, not proof that an applicant lacks
// experience. Keep these roles scored and reviewable, but do not infer a
// specialist qualification from unrelated technologies mentioned in the ad.
const SECURITY_EXPERIENCE = /\b(?:security engineering|application security|appsec|cloud security|cyber(?: ?security)|penetration testing|threat model(?:ing|ling)|incident response|vulnerability management|detection engineering|security architecture)\b/i;
const SECURITY_TITLE = /\b(?:security|cybersecurity|appsec)\s+(?:(?:software|platform|cloud|application)\s+)?(?:engineer|developer|architect)\b|\b(?:engineer|developer|architect)[,\s/-]+(?:security|cybersecurity|appsec)\b/i;
const EXPLICIT_SPECIALIST_REQUIREMENTS = [
  { label: "penetration testing", pattern: /\bpenetration testing\b/i },
  { label: "threat modeling", pattern: /\bthreat model(?:ing|ling)\b/i },
  { label: "incident response", pattern: /\bincident response\b/i },
  { label: "vulnerability management", pattern: /\bvulnerability management\b/i },
  { label: "security engineering", pattern: /\bsecurity engineering\b/i }
];

function advisoryFitReview(opportunity, profile) {
  const title = String(opportunity.title ?? "");
  const description = String(opportunity.description ?? "");
  const verifiedSkills = (profile.skills ?? []).map((skill) => String(skill));
  if (SECURITY_TITLE.test(title)
    && !verifiedSkills.some((skill) => SECURITY_EXPERIENCE.test(skill))) {
    return { reason: "unverified_specialization", requirement: "security engineering" };
  }
  for (const requirement of EXPLICIT_SPECIALIST_REQUIREMENTS) {
    const mustHave = new RegExp(
      `\\b(?:must[- ]have|requires?|required)\\b[^.!?;\\n]{0,120}${requirement.pattern.source}`, "i");
    if (mustHave.test(description)
      && !verifiedSkills.some((skill) => requirement.pattern.test(skill))) {
      return { reason: "unverified_specialization", requirement: requirement.label };
    }
  }
  return null;
}

function compensationEvidence(opportunity, profile, mode, modePreferences) {
  const compensation = opportunity.compensation;
  const defaultMinimum = mode === "freelance"
    ? modePreferences.minimumHourlyRate ?? profile.preferences?.minimumHourlyRate
    : modePreferences.minimumCompensation ?? profile.preferences?.minimumCompensation;
  const basis = normalizedCompensationBasis(compensation?.basis);
  const minimum = mode === "freelance" || basis === "gross"
    ? defaultMinimum
    : basis === "net"
      ? modePreferences.minimumNetCompensation
        ?? profile.preferences?.minimumNetCompensation
        ?? defaultMinimum
      : modePreferences.minimumUnspecifiedCompensation
        ?? profile.preferences?.minimumUnspecifiedCompensation
        ?? defaultMinimum;
  if (!minimum || !compensation) return {};
  const maximum = Number(compensation.maximum ?? compensation.minimum);
  if (!Number.isFinite(maximum)) return {};
  const profileCurrency = String(modePreferences.compensationCurrency
    ?? profile.preferences?.compensationCurrency ?? "").toUpperCase();
  const offeredCurrency = String(compensation.currency ?? "").toUpperCase();
  if (profileCurrency && offeredCurrency && profileCurrency !== offeredCurrency) {
    const majorCurrencies = new Set(["EUR", "USD", "GBP", "CHF", "AUD", "CAD", "NZD"]);
    const offeredFactor = PERIOD_FACTORS[String(compensation.period ?? "year").toLowerCase()];
    const minimumPeriod = mode === "freelance" ? "hour" : modePreferences.compensationPeriod ?? "year";
    const minimumFactor = PERIOD_FACTORS[String(minimumPeriod).toLowerCase()];
    // These currencies are close enough in magnitude that an offer below
    // half the configured floor is unambiguously too low without pretending
    // to provide live FX conversion. Borderline cross-currency offers remain
    // conflicts for review.
    if (majorCurrencies.has(profileCurrency) && majorCurrencies.has(offeredCurrency)
      && offeredFactor && minimumFactor
      && maximum * offeredFactor < Number(minimum) * minimumFactor * 0.5) {
      return { exclusion: `maximum ${offeredCurrency} compensation is clearly below the configured minimum` };
    }
    return { conflict: "compensation_conflict" };
  }
  if (!profileCurrency || !offeredCurrency) return {};
  const offeredFactor = PERIOD_FACTORS[String(compensation.period ?? "year").toLowerCase()];
  const minimumPeriod = mode === "freelance" ? "hour" : modePreferences.compensationPeriod ?? "year";
  const minimumFactor = PERIOD_FACTORS[String(minimumPeriod).toLowerCase()];
  if (!offeredFactor || !minimumFactor) return {};
  const offeredAnnual = maximum * offeredFactor;
  const minimumAnnual = Number(minimum) * minimumFactor;
  if (offeredAnnual < minimumAnnual) {
    return { exclusion: `maximum ${offeredCurrency} compensation is below the configured minimum` };
  }
  return { comparable: true };
}

export function scoreOpportunity(opportunity, profile, mode, { version = "2" } = {}) {
  const searchable = `${opportunity.title} ${opportunity.description} ${(opportunity.tags ?? []).join(" ")}`.toLowerCase();
  const modePreferences = mode === "freelance"
    ? profile.preferences?.freelance ?? {}
    : profile.preferences?.fullTime ?? {};
  const exclusions = [];
  const conflicts = [...(opportunity.conflicts ?? [])];
  const excludedTitle = (modePreferences.excludedTitles ?? [])
    .find((title) => includesPhrase(String(opportunity.title ?? "").toLowerCase(), title));
  if (excludedTitle) exclusions.push(`excluded title: ${excludedTitle}`);
  if (mode === "full_time" && unrelatedOccupationTitle(opportunity.title)) {
    exclusions.push("title identifies an unrelated occupation");
  }
  if (modePreferences.remoteOnly === true && opportunity.remote !== true) exclusions.push("profile requires a remote role");

  const allowedLocations = modePreferences.allowedLocations
    ?? profile.preferences?.allowedLocations ?? profile.preferences?.locations ?? [];
  const excludedLocations = modePreferences.excludedLocations
    ?? profile.preferences?.excludedLocations ?? [];
  const excludedLocation = excludedLocationReason(opportunity, excludedLocations, allowedLocations);
  if (excludedLocation) exclusions.push(excludedLocation);
  const locationReason = locationExclusion(opportunity, allowedLocations);
  if (locationReason) exclusions.push(locationReason);

  const acceptedTypes = (modePreferences.employmentTypes ?? []).map(normalizedEmployment).filter(Boolean);
  const offeredType = normalizedEmployment(opportunity.employmentType);
  if (offeredType && acceptedTypes.length && !acceptedTypes.includes(offeredType)) {
    exclusions.push(`employment type ${opportunity.employmentType} is not accepted`);
  }
  exclusions.push(...qualityExclusions(opportunity, profile, acceptedTypes, allowedLocations));

  const pay = compensationEvidence(opportunity, profile, mode, modePreferences);
  if (pay.exclusion) exclusions.push(pay.exclusion);
  if (pay.conflict && !conflicts.includes(pay.conflict)) conflicts.push(pay.conflict);

  const skills = profile.skills ?? [];
  const skillEvidence = version === "1"
    ? skills.filter((skill) => includesPhrase(searchable, skill)).map((skill) => ({ skill, canonical: skill,
      alias: skill, evidence: "legacy substring match" }))
    : matchSkills(searchable, skills);
  const matchedSkills = skillEvidence.map((item) => item.skill);
  const skillDenominator = Math.max(1, Math.min(skills.length, 6));
  const skillScore = Math.min(50, Math.round((matchedSkills.length / skillDenominator) * 50));
  const titleGroups = mode === "freelance"
    ? { primary: modePreferences.services ?? [], secondary: [] }
    : preferredTitleGroups(profile);
  const preferredTitles = titleGroups.primary;
  const secondaryTitles = titleGroups.secondary;
  const titleWords = words(opportunity.title);
  const preferredWords = new Set(preferredTitles.flatMap((title) => [...words(title)]));
  const secondaryWords = new Set(secondaryTitles.flatMap((title) => [...words(title)]));
  const primaryMatches = [...titleWords].filter((word) => preferredWords.has(word)).length;
  const secondaryMatches = [...titleWords].filter((word) => secondaryWords.has(word)).length;
  const titlePriority = mode === "freelance" ? undefined : configuredTitlePriority(opportunity.title, profile);
  const rolePriority = titlePriority
    ?? (mode === "full_time" && modePreferences.opportunisticRoles?.enabled === true
      ? "opportunistic"
      : undefined);
  const titleScore = titlePriority === "secondary"
    ? Math.min(14, secondaryMatches * 5)
    : Math.min(25, primaryMatches * 8);

  const locationText = String(opportunity.location ?? "").toLowerCase();
  const locationScore = opportunity.remote && allowedLocations.some((value) => /remote|worldwide|anywhere|global/i.test(value))
    ? 10 : allowedLocations.some((value) => includesPhrase(locationText, value)) ? 10 : 0;
  const posted = Date.parse(opportunity.postedAt ?? "");
  const ageDays = Number.isFinite(posted) ? Math.max(0, (Date.now() - posted) / 86_400_000) : 30;
  const recencyScore = ageDays <= 3 ? 10 : ageDays >= 14 ? 0 : Math.round(10 * (14 - ageDays) / 11);
  const compensationScore = !opportunity.compensation ? 3 : pay.comparable ? 5 : 0;
  const semanticScore = Number(opportunity.semanticScore);
  const semanticContribution = version !== "1" && Number.isFinite(semanticScore)
    ? Math.max(0, Math.min(10, Math.round((semanticScore > 1 ? semanticScore / 100 : semanticScore) * 10))) : 0;
  const score = exclusions.length ? 0
    : Math.min(100, skillScore + titleScore + locationScore + recencyScore + compensationScore + semanticContribution);
  const fitReview = exclusions.length ? null : advisoryFitReview(opportunity, profile);
  return {
    score, conflicts,
    scoreDetails: {
      scorerVersion: version === "1" ? "1.0.0" : "2.0.0",
      hardExclusion: exclusions[0], hardExclusions: exclusions,
      conflicts, matchedSkills, skillEvidence, skillScore, titleScore, titlePriority, rolePriority,
      compensationComparable: pay.comparable === true,
      fitReview,
      locationScore, recencyScore, compensationScore, semanticContribution,
      uncertainties: opportunity.uncertainties ?? []
    }
  };
}
