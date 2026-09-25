// Keep model fit packets small and avoid contact details, document paths,
// credentials, demographic answers, and submission policy internals.
export function fitReviewContext(profile, mode = "full_time") {
  const preferences = mode === "freelance"
    ? profile?.preferences?.freelance ?? {} : profile?.preferences?.fullTime ?? {};
  const examples = (profile?.verifiedExamples ?? [])
    .filter((item) => Date.parse(item.reviewAfter ?? "") > Date.now())
    .slice(0, 30).map((item) => ({ id: item.id, facts: item.facts,
      scope: item.scope }));
  const experienceFacts = Object.fromEntries(Object.entries(profile?.applicationAnswers ?? {})
    .filter(([question, answer]) => /\b(years? of|experience with|worked with|built|led a team)\b/i.test(question)
      && !/authorization|visa|salary|compensation|gender|ethnic|disabil|birth|legal|privacy|consent|phone|email/i
        .test(question)
      && (typeof answer === "string" || typeof answer === "number")
      && String(answer).length <= 200)
    .slice(0, 50));
  return {
    mode, skills: (profile?.skills ?? []).slice(0, 100),
    location: { city: profile?.contact?.city, country: profile?.contact?.country },
    preferences: {
      locations: profile?.preferences?.locations ?? [],
      allowedLocations: preferences.allowedLocations ?? [],
      remoteOnly: preferences.remoteOnly === true,
      employmentTypes: preferences.employmentTypes ?? [],
      excludedTitles: preferences.excludedTitles ?? [],
      ...(mode === "freelance" ? { services: preferences.services ?? [] }
        : { jobTitles: preferences.jobTitles ?? [],
          secondaryJobTitles: preferences.secondaryJobTitles ?? [] })
    },
    verifiedExamples: examples, experienceFacts
  };
}
