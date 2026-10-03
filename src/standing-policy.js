import { randomUUID } from "node:crypto";

export const LEGAL_ATTESTATION_FIELD = /\b(?:legal(?:ly)?|authori[sz](?:ed|ation)|consent|certif(?:y|ication)|agree|privacy policy|terms of (?:use|service)|work (?:eligib(?:le|ility)|permit|authori[sz]ation)|right to work|visa|sponsorship|sponsor|citizen(?:ship)?|immigration|background check|export control|security clearance)\b/i;

export function validateStandingPolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("policy must be an object");
  const keys = new Set(["mode", "modes", "sources", "destinationHosts", "dailyCap", "campaignCap",
    "answerClasses", "expiresAt"]);
  if (Object.keys(input).some((key) => !keys.has(key))) throw bad("unknown standing policy field");
  if (!["automatic", "always"].includes(input.mode)) throw bad("policy mode must be automatic or always");
  for (const [name, values, limit] of [["modes", input.modes, 2], ["sources", input.sources, 100],
    ["destinationHosts", input.destinationHosts, 100], ["answerClasses", input.answerClasses, 20]]) {
    if (!Array.isArray(values) || !values.length || values.length > limit
      || values.some((value) => typeof value !== "string" || !value || value.length > 200)) {
      throw bad(`${name} must be a nonempty string array`);
    }
  }
  if (input.modes.some((mode) => !["full_time", "freelance"].includes(mode))) throw bad("invalid policy mode scope");
  if (input.answerClasses.some((item) => !["profile_fact", "resume", "link", "grounded_prose"].includes(item))) {
    throw bad("invalid answer class");
  }
  for (const [name, value] of [["dailyCap", input.dailyCap], ["campaignCap", input.campaignCap]]) {
    if (!Number.isInteger(value) || value < 1 || value > 100) throw bad(`${name} must be 1 to 100`);
  }
  if (input.expiresAt !== undefined && (Number.isNaN(Date.parse(input.expiresAt))
    || Date.parse(input.expiresAt) <= Date.now())) throw bad("policy expiry must be in the future");
  return { ...input, sources: [...new Set(input.sources)], destinationHosts: [...new Set(input.destinationHosts
    .map((host) => host.toLowerCase()))], modes: [...new Set(input.modes)],
  answerClasses: [...new Set(input.answerClasses)] };
}

export function nextStandingPolicy(current, input, identity) {
  if (!identity?.roles?.includes("owner")) throw Object.assign(new Error("owner authority required"), { status: 403 });
  const body = validateStandingPolicy(input);
  return { ...body, id: current?.id ?? randomUUID(), version: (current?.version ?? 0) + 1,
    enabledAt: body.mode === "automatic" ? new Date().toISOString() : null,
    revokedAt: body.mode === "always" ? new Date().toISOString() : null,
    ownerActorId: identity.actorId, updatedAt: new Date().toISOString() };
}

function bad(message) { return Object.assign(new Error(message), { status: 400 }); }
