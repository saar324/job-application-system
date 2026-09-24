// Keyed discovery sources take deployment-wide secrets from the server process
// environment only. The discovery service resolves them and passes the frozen
// result to adapters, which never read process.env themselves.
export const SOURCE_CREDENTIAL_ENV = Object.freeze({
  adzuna: Object.freeze({ appId: "ADZUNA_APP_ID", appKey: "ADZUNA_APP_KEY" })
});

export const SOURCE_CREDENTIAL_ENV_NAMES = Object.freeze(Object.values(SOURCE_CREDENTIAL_ENV)
  .flatMap((names) => Object.values(names)));

export const REDACTED = "[redacted]";

export function isKeyedSource(sourceId) { return Object.hasOwn(SOURCE_CREDENTIAL_ENV, sourceId); }

export function sourceCredentials(sourceId, env = {}) {
  const names = SOURCE_CREDENTIAL_ENV[sourceId];
  if (!names) return null;
  const entries = Object.entries(names).map(([field, name]) => [field, String(env?.[name] ?? "").trim()]);
  return entries.every(([, value]) => value) ? Object.freeze(Object.fromEntries(entries)) : null;
}

export function missingCredentialMessage(sourceId) {
  return `source_not_configured: set ${Object.values(SOURCE_CREDENTIAL_ENV[sourceId] ?? {}).join(" and ")}`
    + " in the server environment";
}

const SECRET_PARAMETER = /\b(app_id|app_key|api_key|apikey|access_token|token|key)=([^&\s"'<>]+)/gi;

// Replaces every raw or URL-encoded credential value, then any value of a
// well-known secret query parameter, so echoed request URLs cannot leak.
export function redactSecrets(text, ...credentialSets) {
  const secrets = credentialSets.flatMap((credentials) => Object.values(credentials ?? {}))
    .filter((value) => typeof value === "string" && value)
    .flatMap((value) => [value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2)])
    .sort((left, right) => right.length - left.length);
  let result = String(text ?? "");
  for (const secret of new Set(secrets)) result = result.split(secret).join(REDACTED);
  return result.replace(SECRET_PARAMETER, (match, name, value) =>
    value === REDACTED || value === encodeURIComponent(REDACTED) ? match : `${name}=${REDACTED}`);
}
