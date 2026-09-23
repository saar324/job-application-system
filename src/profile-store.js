import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { nextStandingPolicy } from "./standing-policy.js";
import { answerEvidenceFingerprint, approvedAnswerFingerprint } from "./approved-answers.js";

const ALLOWED_SECTIONS = new Set([
  "displayName", "defaultMode", "contact", "links", "skills", "preferences", "documents", "applicationAnswers",
]);
const CREDENTIAL_KEY = /(?:^|[_-])(?:password|passwd|passcode|secret|token|api[_-]?key|otp|cookie)(?:$|[_-])/i;

function merge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw Object.assign(new Error(`profile field is not allowed: ${key}`), { status: 400 });
    }
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(result[key], value)
      : value;
  }
  return result;
}

function present(value) {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "";
}

function at(object, dotted) {
  return dotted.split(".").reduce((value, key) => value?.[key], object);
}

export class ProfileStore {
  #file;
  #allowMissing;
  #pending = Promise.resolve();

  constructor(file, { allowMissing = false } = {}) {
    this.#file = path.resolve(file);
    this.#allowMissing = allowMissing;
  }

  async init() {
    await this.#read();
    return this;
  }

  async get(profileId) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profileId ?? "")) return null;
    const document = await this.#read();
    return document.profiles.find((profile) => profile.id === profileId) ?? null;
  }

  async status(profileId, requestedMode, fallbackMode = "full_time") {
    const profile = await this.get(profileId) ?? { id: profileId };
    const applicationFields = [
      "contact.firstName", "contact.lastName", "contact.email", "contact.phone",
      "contact.location", "documents.resume"
    ];
    const searchFields = ["skills", "preferences.locations"];
    const mode = requestedMode ?? profile.defaultMode ?? fallbackMode;
    searchFields.push(mode === "freelance" ? "preferences.freelance.services" : "preferences.fullTime.jobTitles");
    const missingForApplications = applicationFields.filter((field) => !present(at(profile, field)));
    const missingForSearch = searchFields.filter((field) => !present(at(profile, field)));
    return {
      profileId,
      displayName: profile.displayName,
      defaultMode: mode,
      readyToApply: missingForApplications.length === 0,
      readyToSearch: missingForSearch.length === 0,
      missingForApplications,
      missingForSearch
    };
  }

  async patch(profileId, input) {
    for (const key of Object.keys(input)) {
      if (!ALLOWED_SECTIONS.has(key)) throw Object.assign(new Error(`profile field is not allowed: ${key}`), { status: 400 });
    }
    rejectSensitiveApplicationAnswers(input.applicationAnswers);
    const operation = this.#pending.then(async () => {
      const document = await this.#read();
      const index = document.profiles.findIndex((profile) => profile.id === profileId);
      const current = index >= 0 ? document.profiles[index] : { id: profileId };
      const updated = { ...merge(current, input), id: profileId };
      if (updated.defaultMode && !["full_time", "freelance"].includes(updated.defaultMode)) {
        throw Object.assign(new Error("defaultMode must be full_time or freelance"), { status: 400 });
      }
      for (const section of ["fullTime", "freelance"]) {
        const approval = updated.preferences?.[section]?.submissionApproval;
        if (approval && !["automatic", "always"].includes(approval)) {
          throw Object.assign(new Error(`${section}.submissionApproval must be automatic or always`), { status: 400 });
        }
        const dailyApplicationCap = updated.preferences?.[section]?.dailyApplicationCap;
        if (dailyApplicationCap !== undefined
          && (!Number.isInteger(dailyApplicationCap) || dailyApplicationCap < 0 || dailyApplicationCap > 100)) {
          throw Object.assign(new Error(`${section}.dailyApplicationCap must be an integer from 0 to 100, where 0 disables the cap`), { status: 400 });
        }
      }
      const maxApplicationsPerDay = updated.preferences?.maxApplicationsPerDay;
      if (maxApplicationsPerDay !== undefined
        && (!Number.isInteger(maxApplicationsPerDay) || maxApplicationsPerDay < 0 || maxApplicationsPerDay > 100)) {
        throw Object.assign(new Error("preferences.maxApplicationsPerDay must be an integer from 0 to 100, where 0 disables the cap"), { status: 400 });
      }
      if (index >= 0) document.profiles[index] = updated;
      else document.profiles.push(updated);
      await this.#write(document);
      return this.status(profileId);
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  async setStandingSubmissionPolicy(profileId, input, identity) {
    if (identity?.profileId !== profileId || !identity?.roles?.includes("owner")) {
      throw Object.assign(new Error("owner authority required for this profile"), { status: 403 });
    }
    const operation = this.#pending.then(async () => {
      const document = await this.#read();
      const index = document.profiles.findIndex((profile) => profile.id === profileId);
      const current = index >= 0 ? document.profiles[index] : { id: profileId };
      const standingSubmissionPolicy = nextStandingPolicy(current.standingSubmissionPolicy, input, identity);
      const updated = { ...current, standingSubmissionPolicy,
        standingPolicyHistory: [...(current.standingPolicyHistory ?? []).slice(-99), {
          policyId: standingSubmissionPolicy.id, version: standingSubmissionPolicy.version,
          mode: standingSubmissionPolicy.mode, ownerActorId: identity.actorId,
          recordedAt: standingSubmissionPolicy.updatedAt
        }] };
      if (index >= 0) document.profiles[index] = updated;
      else document.profiles.push(updated);
      await this.#write(document);
      return standingSubmissionPolicy;
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  async setApprovedAnswers(profileId, records, identity) {
    if (identity?.profileId !== profileId || !identity?.roles?.includes("owner")) {
      throw Object.assign(new Error("owner authority required for approved answers"), { status: 403 });
    }
    validateApprovedAnswers(records);
    const operation = this.#pending.then(async () => {
      const document = await this.#read();
      const index = document.profiles.findIndex((profile) => profile.id === profileId);
      const current = index >= 0 ? document.profiles[index] : { id: profileId };
      const approvedAt = new Date();
      const evidenceFingerprint = answerEvidenceFingerprint(current);
      const approvedAnswers = records.map((item) => {
        const reviewAfter = item.reviewAfter ? new Date(item.reviewAfter)
          : new Date(approvedAt.getTime() + 14 * 86_400_000);
        if (reviewAfter <= approvedAt || reviewAfter.getTime() - approvedAt.getTime() > 30 * 86_400_000) {
          throw Object.assign(new Error("approved answer reviewAfter must be within 30 days"), { status: 400 });
        }
        const answer = { id: item.id, question: item.question.trim(), value: item.value.trim(),
          scope: { employer: item.scope.employer.trim(),
            ...(item.scope.role ? { role: item.scope.role.trim() } : {}) },
          approvedAt: approvedAt.toISOString(), reviewAfter: reviewAfter.toISOString(),
          evidenceFingerprint, ownerActorId: identity.actorId };
        return { ...answer, contentFingerprint: approvedAnswerFingerprint(answer) };
      });
      const updated = { ...current, approvedAnswers };
      if (index >= 0) document.profiles[index] = updated;
      else document.profiles.push(updated);
      await this.#write(document);
      return { count: approvedAnswers.length, approvedAt: approvedAt.toISOString() };
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  async #read() {
    let raw;
    try { raw = await readFile(this.#file, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT" && this.#allowMissing) return { profiles: [] };
      throw error;
    }
    const document = JSON.parse(raw);
    if (!Array.isArray(document.profiles)) throw new Error("profiles file must contain a profiles array");
    return document;
  }

  async #write(document) {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#file);
  }
}

function validateApprovedAnswers(records) {
  if (records === undefined) return;
  if (!Array.isArray(records) || records.length > 200) {
    throw Object.assign(new Error("approvedAnswers must contain at most 200 records"), { status: 400 });
  }
  for (const item of records) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof item.id !== "string" || !item.id.trim() || item.id.length > 100
      || typeof item.question !== "string" || !item.question.trim() || item.question.length > 1000
      || typeof item.value !== "string" || !item.value.trim() || item.value.length > 5000
      || item.reviewAfter && Number.isNaN(Date.parse(item.reviewAfter))
      || !item.scope || typeof item.scope !== "object" || Array.isArray(item.scope)
      || typeof item.scope.employer !== "string" || !item.scope.employer.trim()
      || item.scope.role !== undefined && (typeof item.scope.role !== "string" || !item.scope.role.trim())
      || Object.keys(item.scope).some((key) => !["employer", "role"].includes(key))
      || CREDENTIAL_KEY.test(item.question)) {
      throw Object.assign(new Error("approvedAnswers contains an invalid record"), { status: 400 });
    }
  }
}

function rejectSensitiveApplicationAnswers(value, path = "applicationAnswers") {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const field = `${path}.${key}`;
    if (CREDENTIAL_KEY.test(key)) {
      throw Object.assign(new Error(`credential fields are not allowed in applicationAnswers: ${field}`), { status: 400 });
    }
    rejectSensitiveApplicationAnswers(nested, field);
  }
}
