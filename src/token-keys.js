import { createHash } from "node:crypto";

const HASH_KEY = /^sha256:([0-9a-f]{64})$/i;

export function tokenDigest(token) {
  return createHash("sha256").update(token).digest();
}

export function hashedTokenKey(token) {
  if (typeof token !== "string" || !token) throw new Error("token must be a nonempty string");
  return `sha256:${tokenDigest(token).toString("hex")}`;
}

export function digestFromTokenKey(key) {
  if (typeof key !== "string" || !key) throw new Error("token map contains an empty key");
  if (/^sha256:/i.test(key)) {
    const match = HASH_KEY.exec(key);
    if (!match) throw new Error("token map contains a malformed sha256 key");
    return Buffer.from(match[1], "hex");
  }
  return tokenDigest(key);
}
