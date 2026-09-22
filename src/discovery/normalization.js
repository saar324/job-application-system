import { plainText } from "./text.js";

export const OPPORTUNITY_SCHEMA_VERSION = "1.0.0";

function evidence(source, path, value, confidence = "high") {
  return { source, path, confidence, observedAt: new Date().toISOString(), excerpt: String(value ?? "").slice(0, 320) };
}

export function normalizeEmploymentType(value) {
  const text = String(value ?? "").toLowerCase().replace(/[_-]+/g, " ").trim();
  if (/full\s*time|permanent/.test(text)) return "full_time";
  if (/part\s*time/.test(text)) return "part_time";
  if (/contract|contractor|freelance|temporary|temp\b/.test(text)) return "contract";
  if (/intern/.test(text)) return "internship";
  return text || undefined;
}

export function normalizeOpportunity(raw, { source = raw.source ?? "unknown" } = {}) {
  const normalized = { ...raw };
  normalized.schemaVersion = OPPORTUNITY_SCHEMA_VERSION;
  normalized.normalizedAt = new Date().toISOString();
  normalized.title = String(raw.title ?? "").trim();
  normalized.company = String(raw.company ?? "").trim();
  normalized.description = plainText(raw.description ?? "");
  normalized.location = String(raw.location ?? "").trim();
  normalized.employmentType = normalizeEmploymentType(raw.employmentType);
  normalized.remote = raw.remote === true || /\b(remote|worldwide|anywhere|distributed)\b/i.test(normalized.location);
  normalized.provenance = {
    ...(raw.provenance ?? {}),
    title: raw.title ? evidence(source, "title", raw.title) : undefined,
    company: raw.company ? evidence(source, "company", raw.company) : undefined,
    description: raw.description ? evidence(source, "description", raw.description, "medium") : undefined,
    location: raw.location ? evidence(source, "location", raw.location) : undefined,
    employmentType: raw.employmentType ? evidence(source, "employmentType", raw.employmentType) : undefined,
    compensation: raw.compensation ? evidence(source, "compensation", JSON.stringify(raw.compensation)) : undefined,
    applicationQuestions: raw.applicationQuestions?.length
      ? evidence(source, "applicationQuestions", `${raw.applicationQuestions.length} questions`) : undefined
  };
  normalized.uncertainties = [...new Set([
    ...(raw.uncertainties ?? []),
    ...(!normalized.location ? ["location_unknown"] : []),
    ...(!normalized.employmentType ? ["employment_type_unknown"] : []),
    ...(!raw.compensation ? ["compensation_unknown"] : [])
  ])];
  return normalized;
}

export function parseJobPostingJsonLd(input) {
  const documents = [];
  if (typeof input === "string") {
    const script = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    for (const match of input.matchAll(script)) {
      try { documents.push(JSON.parse(match[1])); } catch {}
    }
    if (!documents.length) {
      try { documents.push(JSON.parse(input)); } catch {}
    }
  } else if (input && typeof input === "object") documents.push(input);
  const nodes = documents.flatMap(flattenJsonLd);
  const job = nodes.find((item) => typesOf(item).includes("JobPosting"));
  if (!job) return null;
  const locations = arrayOf(job.jobLocation).map((item) => [
    item?.address?.addressLocality, item?.address?.addressRegion, item?.address?.addressCountry
  ].filter(Boolean).join(", ")).filter(Boolean);
  const applicantLocations = arrayOf(job.applicantLocationRequirements)
    .map((item) => item?.name ?? item?.addressCountry).filter(Boolean);
  const compensation = compensationOf(job.baseSalary ?? job.estimatedSalary);
  const result = normalizeOpportunity({
    source: "schema.org",
    externalId: job.identifier?.value ?? job.identifier,
    title: job.title,
    company: job.hiringOrganization?.name,
    description: job.description,
    listingUrl: job.url,
    applyUrl: job.url,
    location: [...locations, ...applicantLocations].join(", ") || job.jobLocationType,
    remote: /telecommute|remote/i.test(String(job.jobLocationType ?? "")),
    employmentType: arrayOf(job.employmentType).join(", "),
    postedAt: job.datePosted,
    validThrough: job.validThrough,
    compensation,
    workAuthorization: job.eligibilityToWorkRequirement,
    directApply: job.directApply === true
  }, { source: "schema.org" });
  result.rawStructuredType = "JobPosting";
  return result;
}

function flattenJsonLd(value) {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== "object") return [];
  return [value, ...flattenJsonLd(value["@graph"] ?? [])];
}

function typesOf(value) { return arrayOf(value?.["@type"]); }
function arrayOf(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }

function compensationOf(value) {
  if (!value) return undefined;
  const amount = value.value ?? value;
  const minimum = Number(amount.minValue ?? amount.value ?? amount);
  const maximum = Number(amount.maxValue ?? amount.value ?? amount);
  if (!Number.isFinite(minimum) && !Number.isFinite(maximum)) return undefined;
  return {
    minimum: Number.isFinite(minimum) ? minimum : maximum,
    maximum: Number.isFinite(maximum) ? maximum : minimum,
    currency: value.currency,
    period: String(amount.unitText ?? "year").toLowerCase()
  };
}

export function normalizeApplicationQuestions(questions = []) {
  return questions.slice(0, 200).map((question, index) => ({
    key: String(question.name ?? question.id ?? question.fields?.[0]?.name
      ?? question.fields?.[0]?.id ?? `question_${index}`),
    label: plainText(question.label ?? question.name ?? `Question ${index + 1}`),
    type: String(question.type ?? question.fields?.[0]?.type ?? "text").toLowerCase(),
    required: question.required === true || question.fields?.some((field) => field.required === true) === true,
    options: (question.values ?? question.options ?? question.fields?.[0]?.values ?? [])
      .slice(0, 100).map((option) => ({ value: option.value ?? option.id ?? option.label, label: option.label ?? option.name ?? option.value }))
  }));
}
