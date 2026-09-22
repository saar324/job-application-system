import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const ALLOWED_SECTIONS = new Set([
  "displayName", "defaultMode", "contact", "links", "skills", "preferences", "documents", "applicationAnswers"
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
