import { searchTitleQueryPlan } from "./search-title-queries.js";

export function browserQueryPlan({ explicitQuery, seed, sourceCycle = 0, searchCycle, maximum = 5 }) {
  if (String(explicitQuery ?? "").trim()) {
    return { queries: [{ term: String(explicitQuery).trim(), origin: "explicit" }],
      skippedTerms: [], coverageBlocked: false, cycle: null };
  }
  if (!seed) return { queries: [], skippedTerms: [], coverageBlocked: true, cycle: null };
  const titles = seed.verifiedSubmittedTitles ?? [];
  if (!seed.profile || !Array.isArray(titles)
    || Object.keys(seed.profile).some((key) => key !== "preferences")
    || titles.some((title) => typeof title !== "string")) {
    throw new Error("query plan file requires preference-only profile and verifiedSubmittedTitles");
  }
  const cycle = Number(searchCycle ?? seed.cycle ?? sourceCycle);
  if (!Number.isInteger(cycle) || cycle < 0) throw new Error("search-cycle must be nonnegative");
  return searchTitleQueryPlan(seed.profile, titles, { maximum, cycle });
}
