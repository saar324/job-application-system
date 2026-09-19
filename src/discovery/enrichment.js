import { createHash } from "node:crypto";

export class HttpSemanticProvider {
  constructor({ endpoint, token, model = "default", fetchImpl = fetch }) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.token = token;
    this.model = model;
    this.fetchImpl = fetchImpl;
  }

  async extract(text, signal) {
    return this.#request("extract", {
      model: this.model, text,
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          requiredSkills: { type: "array", items: { type: "string" } },
          preferredSkills: { type: "array", items: { type: "string" } },
          seniority: { type: ["string", "null"] },
          workAuthorization: { type: ["string", "null"] },
          locationRestrictions: { type: ["string", "null"] },
          evidenceSpans: { type: "array", items: { type: "object", properties: {
            field: { type: "string" }, text: { type: "string" }
          }, required: ["field", "text"], additionalProperties: false } }
        }, required: ["requiredSkills", "preferredSkills", "seniority", "workAuthorization", "locationRestrictions", "evidenceSpans"]
      }
    }, signal);
  }

  async embed(inputs, signal) { return this.#request("embed", { model: this.model, inputs }, signal); }

  async #request(path, body, signal) {
    const response = await this.fetchImpl(`${this.endpoint}/${path}`, {
      method: "POST", headers: { "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(body), signal
    });
    if (!response.ok) throw new Error(`semantic provider returned HTTP ${response.status}`);
    return response.json();
  }
}

export class OpportunityEnricher {
  constructor({ provider, timeoutMs = 15_000, maxCharacters = 24_000, version = "1" }) {
    this.provider = provider;
    this.timeoutMs = timeoutMs;
    this.maxCharacters = maxCharacters;
    this.version = version;
    this.cache = new Map();
  }

  async enrich(opportunity, profile) {
    const publicText = `${opportunity.title}\n${opportunity.description}`.slice(0, this.maxCharacters);
    const key = createHash("sha256").update(`${this.version}\0${publicText}`).digest("hex");
    let extraction = this.cache.get(`extract:${key}`);
    if (!extraction) {
      extraction = validateExtraction(await bounded(this.timeoutMs, (signal) => this.provider.extract(publicText, signal)));
      this.cache.set(`extract:${key}`, extraction);
    }
    const profileText = (profile.skills ?? []).join(", ").slice(0, 4_000);
    let semanticScore;
    if (profileText) {
      const embeddingKey = createHash("sha256").update(`${this.version}\0${publicText}\0${profileText}`).digest("hex");
      semanticScore = this.cache.get(`similarity:${embeddingKey}`);
      if (semanticScore === undefined) {
        const response = await bounded(this.timeoutMs, (signal) => this.provider.embed([publicText, profileText], signal));
        semanticScore = Number(response.similarity ?? cosine(response.embeddings?.[0], response.embeddings?.[1]));
        if (!Number.isFinite(semanticScore)) semanticScore = undefined;
        this.cache.set(`similarity:${embeddingKey}`, semanticScore);
      }
    }
    return {
      ...opportunity,
      requiredSkills: opportunity.requiredSkills?.length ? opportunity.requiredSkills : extraction.requiredSkills,
      preferredSkills: opportunity.preferredSkills?.length ? opportunity.preferredSkills : extraction.preferredSkills,
      seniority: opportunity.seniority ?? extraction.seniority ?? undefined,
      workAuthorization: opportunity.workAuthorization ?? extraction.workAuthorization ?? undefined,
      locationRestrictions: opportunity.locationRestrictions ?? extraction.locationRestrictions ?? undefined,
      semanticScore,
      enrichment: { version: this.version, evidenceSpans: extraction.evidenceSpans, provider: "http" }
    };
  }
}

export function semanticEnricherFromEnv(env = process.env, fetchImpl = fetch) {
  if (env.JOB_SEMANTIC_ENABLED !== "true" || !env.JOB_SEMANTIC_ENDPOINT) return null;
  return new OpportunityEnricher({
    provider: new HttpSemanticProvider({ endpoint: env.JOB_SEMANTIC_ENDPOINT,
      token: env.JOB_SEMANTIC_TOKEN, model: env.JOB_SEMANTIC_MODEL, fetchImpl }),
    timeoutMs: Number(env.JOB_SEMANTIC_TIMEOUT_MS ?? 15_000),
    maxCharacters: Number(env.JOB_SEMANTIC_MAX_CHARACTERS ?? 24_000),
    version: env.JOB_SEMANTIC_VERSION ?? "1"
  });
}

function validateExtraction(value) {
  const object = value?.result ?? value;
  if (!object || typeof object !== "object" || Array.isArray(object)) throw new Error("semantic extraction was not an object");
  return {
    requiredSkills: strings(object.requiredSkills), preferredSkills: strings(object.preferredSkills),
    seniority: optionalString(object.seniority), workAuthorization: optionalString(object.workAuthorization),
    locationRestrictions: optionalString(object.locationRestrictions),
    evidenceSpans: Array.isArray(object.evidenceSpans) ? object.evidenceSpans.slice(0, 50)
      .filter((item) => item && typeof item.field === "string" && typeof item.text === "string")
      .map((item) => ({ field: item.field.slice(0, 80), text: item.text.slice(0, 320) })) : []
  };
}

function strings(value) { return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 100) : []; }
function optionalString(value) { return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null; }
function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return NaN;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
async function bounded(timeoutMs, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fn(controller.signal); } finally { clearTimeout(timer); }
}
