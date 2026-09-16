import { readFile } from "node:fs/promises";
import path from "node:path";

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(base?.[key] ?? {}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function loadConfig(env = process.env) {
  const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const basePath = path.resolve(projectRoot, "config/default.json");
  const selectedPath = path.resolve(env.JOB_SERVER_CONFIG ?? basePath);
  const base = await readJson(basePath);
  const selected = selectedPath === basePath ? {} : await readJson(selectedPath);
  const config = deepMerge(base, selected);
  if (!config.modes?.[config.defaultMode]) {
    throw new Error(`defaultMode ${config.defaultMode} is not defined in modes`);
  }
  if (!config.execution?.adapter) throw new Error("execution.adapter is required");
  if (!["simulation", "webhook"].includes(config.execution.adapter)) {
    throw new Error(`unsupported execution adapter: ${config.execution.adapter}`);
  }
  for (const [mode, settings] of Object.entries(config.modes)) {
    if (!Number.isFinite(settings.minimumScore) || settings.minimumScore < 0 || settings.minimumScore > 100) {
      throw new Error(`${mode}.minimumScore must be from 0 to 100`);
    }
    if (!Number.isInteger(settings.dailyApplicationCap) || settings.dailyApplicationCap < 1) {
      throw new Error(`${mode}.dailyApplicationCap must be a positive integer`);
    }
    if (!Array.isArray(settings.sources)) throw new Error(`${mode}.sources must be an array`);
    if (!["automatic", "always"].includes(settings.submissionApproval ?? "automatic")) {
      throw new Error(`${mode}.submissionApproval must be automatic or always`);
    }
  }
  return config;
}
