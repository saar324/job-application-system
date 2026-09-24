const SOURCE_KINDS = new Set(["owner_statement", "resume", "portfolio",
  "employment_record", "other_document"]);
const DAY_MS = 86_400_000;

function invalid() {
  return Object.assign(new Error("verifiedExamples contains an invalid record"), { status: 400 });
}

function terms(value) {
  return value === undefined || Array.isArray(value) && value.length <= 8
    && value.every((term) => typeof term === "string" && term.trim().length >= 2
      && term.trim().length <= 80);
}

function plain(value) {
  return String(value ?? "").toLowerCase()
    .replace(/\bfull[\s-]?stack\b/g, "fullstack")
    .replace(/\bback[\s-]?end\b/g, "backend")
    .replace(/\bfront[\s-]?end\b/g, "frontend")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function containsTerm(text, term) {
  const haystack = ` ${plain(text)} `;
  const needle = ` ${plain(term)} `;
  return needle.trim().length > 0 && haystack.includes(needle);
}

export function verifiedExamplesForStorage(records, identity, now = new Date()) {
  if (!Array.isArray(records) || records.length > 100) {
    throw Object.assign(new Error("verifiedExamples must contain at most 100 records"), { status: 400 });
  }
  const ids = new Set();
  return records.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some((key) => !["id", "facts", "source", "scope", "reviewAfter"].includes(key))
      || typeof item.id !== "string" || !/^[a-z0-9_-]{1,80}$/.test(item.id)
      || ids.has(item.id)
      || !Array.isArray(item.facts) || item.facts.length < 1 || item.facts.length > 5
      || item.facts.some((fact) => typeof fact !== "string" || !fact.trim()
        || fact.trim().length > 300)
      || !item.source || typeof item.source !== "object" || Array.isArray(item.source)
      || Object.keys(item.source).some((key) => !["kind", "reference"].includes(key))
      || !SOURCE_KINDS.has(item.source.kind)
      || typeof item.source.reference !== "string" || !item.source.reference.trim()
      || item.source.reference.length > 500
      || !item.scope || typeof item.scope !== "object" || Array.isArray(item.scope)
      || Object.keys(item.scope).some((key) => !["roleTerms", "skillTerms", "employer"].includes(key))
      || !terms(item.scope.roleTerms) || !terms(item.scope.skillTerms)
      || item.scope.employer !== undefined && (typeof item.scope.employer !== "string"
        || !item.scope.employer.trim() || item.scope.employer.length > 200)
      || !(item.scope.roleTerms?.length || item.scope.skillTerms?.length || item.scope.employer)
      || typeof item.reviewAfter !== "string"
      || !Number.isFinite(Date.parse(item.reviewAfter))) throw invalid();
    const reviewAfter = new Date(item.reviewAfter);
    if (reviewAfter <= now || reviewAfter.getTime() - now.getTime() > 90 * DAY_MS) {
      throw Object.assign(new Error("verified example reviewAfter must be within 90 days"), { status: 400 });
    }
    ids.add(item.id);
    return {
      id: item.id,
      facts: item.facts.map((fact) => fact.trim()),
      source: { kind: item.source.kind, reference: item.source.reference.trim() },
      scope: {
        ...(item.scope.roleTerms?.length ? { roleTerms: item.scope.roleTerms.map((term) => term.trim()) } : {}),
        ...(item.scope.skillTerms?.length ? { skillTerms: item.scope.skillTerms.map((term) => term.trim()) } : {}),
        ...(item.scope.employer ? { employer: item.scope.employer.trim() } : {})
      },
      verifiedAt: now.toISOString(), reviewAfter: reviewAfter.toISOString(),
      ownerActorId: identity.actorId
    };
  });
}

export function selectVerifiedExamples(profile, opportunity, now = new Date()) {
  const title = String(opportunity?.title ?? "");
  const description = String(opportunity?.description ?? "");
  const company = plain(opportunity?.company);
  return (Array.isArray(profile?.verifiedExamples) ? profile.verifiedExamples : [])
    .filter((item) => item && /^[a-z0-9_-]{1,80}$/.test(item.id ?? "")
      && Array.isArray(item.facts) && item.facts.length > 0 && item.facts.length <= 5
      && item.facts.every((fact) => typeof fact === "string" && fact.trim()
        && fact.length <= 300)
      && SOURCE_KINDS.has(item.source?.kind)
      && typeof item.source?.reference === "string" && item.source.reference.trim()
      && item.source.reference.length <= 500
      && item.scope && terms(item.scope.roleTerms) && terms(item.scope.skillTerms)
      && (item.scope.roleTerms?.length || item.scope.skillTerms?.length || item.scope.employer)
      && typeof item.ownerActorId === "string" && item.ownerActorId.trim()
      && Number.isFinite(Date.parse(item.verifiedAt))
      && Date.parse(item.verifiedAt) <= now.getTime()
      && Date.parse(item.reviewAfter) > now.getTime()
      && Date.parse(item.reviewAfter) - Date.parse(item.verifiedAt) <= 90 * DAY_MS
      && (!item.scope?.employer || plain(item.scope.employer) === company)
      && (!item.scope?.roleTerms?.length
        || item.scope.roleTerms.some((term) => containsTerm(title, term)))
      && (!item.scope?.skillTerms?.length
        || item.scope.skillTerms.some((term) => containsTerm(`${title} ${description}`, term))))
    .sort((left, right) => Number(Boolean(right.scope?.employer)) - Number(Boolean(left.scope?.employer))
      || Number(Boolean(right.scope?.roleTerms?.length)) - Number(Boolean(left.scope?.roleTerms?.length))
      || Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt))
    .slice(0, 4).map(({ id, facts, source, scope, verifiedAt, reviewAfter }) => ({
      id, facts, source, scope, verifiedAt, reviewAfter
    }));
}
