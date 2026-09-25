import { createHash } from "node:crypto";

// A fit decision belongs to the exact posting the agent reviewed. A refreshed
// description, title, company, or destination requires another review.
export function postingFingerprint(role) {
  const fields = ["title", "company", "description", "applyUrl"]
    .map((key) => String(role?.[key] ?? "").trim());
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export function acceptedFit(role) {
  return role?.fitAssessment?.decision === "relevant"
    && role.fitAssessment.fingerprint === postingFingerprint(role);
}

function employmentType(value) {
  const text = String(value ?? "").toLowerCase().replace(/[_-]+/g, " ");
  if (/full\s*time|permanent/.test(text)) return "full_time";
  if (/part\s*time/.test(text)) return "part_time";
  if (/contract|contractor|freelance|temporary/.test(text)) return "contract";
  if (/intern/.test(text)) return "internship";
  return text.trim() || null;
}

// Simple, explicit applicant preferences stay deterministic. Technology,
// seniority and responsibility fit belong to the agent's listing review.
export function reviewedEligibility(role, profile, mode) {
  const preferences = mode === "freelance"
    ? profile?.preferences?.freelance ?? {} : profile?.preferences?.fullTime ?? {};
  const reasons = [];
  const arrangement = String(role?.workArrangement ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  const location = String(role?.location ?? "").toLowerCase();
  const explicitlyNotRemote = arrangement === "hybrid" || arrangement === "onsite"
    || /\b(?:on[ -]?site|hybrid)\b/.test(location);
  if (preferences.remoteOnly === true && explicitlyNotRemote) {
    reasons.push("profile requires a remote role");
  }
  const title = String(role?.title ?? "").toLowerCase();
  const excludedTitle = (preferences.excludedTitles ?? []).find((value) =>
    typeof value === "string" && value.trim() && title.includes(value.trim().toLowerCase()));
  if (excludedTitle) reasons.push(`excluded title: ${excludedTitle}`);
  const acceptedTypes = (preferences.employmentTypes ?? []).map(employmentType).filter(Boolean);
  const offeredType = employmentType(role?.employmentType);
  if (offeredType && acceptedTypes.length && !acceptedTypes.includes(offeredType)) {
    reasons.push(`employment type ${role.employmentType} is not accepted`);
  }
  return reasons;
}

export function fitPassesGate(role, score, minimumScore, profile, mode) {
  if (acceptedFit(role)) return reviewedEligibility(role, profile, mode).length === 0;
  return !score.scoreDetails.hardExclusion
    && score.score >= minimumScore;
}
