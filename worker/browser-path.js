// The staged headed path is off by default. It changes only the Chromium
// rendering mode; every application still gets an isolated fresh context.
export function browserPathConfig(env = process.env) {
  const enabled = env.WORKER_HEADED_ENABLED === "true";
  const origins = String(env.WORKER_HEADED_ORIGINS ?? "").split(",")
    .map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (enabled && (!origins.length || origins.length > 20 || origins.some((item) =>
    !/^[a-z0-9.-]+$/.test(item) || item.startsWith(".") || item.includes("..")
      || item.includes("*")))) throw new Error("WORKER_HEADED_ORIGINS requires exact hostnames");
  return { defaultHeadless: env.WORKER_HEADLESS !== "false",
    headedOrigins: enabled ? new Set(origins) : new Set() };
}

export function browserPathFor(url, config) {
  return config.headedOrigins.has(new URL(url).hostname.toLowerCase()) ? "headed" : "default";
}
