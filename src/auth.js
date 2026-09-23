import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { digestFromTokenKey, tokenDigest } from "./token-keys.js";

export function createAuthenticator(env = process.env) {
  const disabled = env.AUTH_DISABLED === "true";
  if (disabled) {
    return function authenticate(request) {
      return {
        actorId: request.headers["x-actor-id"] ?? "local-developer",
        profileId: request.headers["x-profile-id"] ?? "local-profile",
        roles: ["agent"]
      };
    };
  }
  const tokenFile = env.JOB_SERVER_TOKENS_FILE ?? "./data/tokens.json";
  const fromEnvironment = env.JOB_SERVER_TOKENS_JSON ? JSON.parse(env.JOB_SERVER_TOKENS_JSON) : {};

  function identities() {
    let fromFile = {};
    try { fromFile = JSON.parse(readFileSync(tokenFile, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT" || env.JOB_SERVER_TOKENS_FILE) throw error;
    }
    const configured = { ...fromFile, ...fromEnvironment };
    const seen = new Set();
    return Object.entries(configured).map(([key, identity]) => {
      const digest = digestFromTokenKey(key);
      const hex = digest.toString("hex");
      if (seen.has(hex)) throw new Error("token map contains duplicate credentials");
      seen.add(hex);
      return { digest, identity };
    });
  }
  identities();

  return function authenticate(request) {
    const authorization = request.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) return null;
    const candidate = tokenDigest(token);
    return identities().find((entry) => timingSafeEqual(entry.digest, candidate))?.identity ?? null;
  };
}
