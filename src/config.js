import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  if (!Number.isInteger(config.execution.concurrency ?? 1) || (config.execution.concurrency ?? 1) < 1
    || (config.execution.concurrency ?? 1) > 32) {
    throw new Error("execution.concurrency must be an integer from 1 to 32");
  }
  if (!Number.isInteger(config.execution.claimLeaseMs ?? 60_000) || (config.execution.claimLeaseMs ?? 60_000) < 1_000) {
    throw new Error("execution.claimLeaseMs must be an integer of at least 1000");
  }
  if (!["1", "2"].includes(String(config.discovery?.scorerVersion ?? "2"))) {
    throw new Error("discovery.scorerVersion must be 1 or 2");
  }
  if (config.discovery?.shadowScorerVersion !== undefined
    && !["1", "2"].includes(String(config.discovery.shadowScorerVersion))) {
    throw new Error("discovery.shadowScorerVersion must be 1 or 2");
  }
  const maximumSemantic = config.discovery?.semantic?.maxCandidates ?? 20;
  if (!Number.isInteger(maximumSemantic) || maximumSemantic < 0 || maximumSemantic > 200) {
    throw new Error("discovery.semantic.maxCandidates must be an integer from 0 to 200");
  }
  const broadenedSources = config.discovery?.broadenedSources ?? {};
  if (!broadenedSources || typeof broadenedSources !== "object" || Array.isArray(broadenedSources)
    || Object.entries(broadenedSources).some(([source, enabled]) =>
      !/^[a-z][a-z0-9_-]{0,79}$/.test(source) || typeof enabled !== "boolean")) {
    throw new Error("discovery.broadenedSources must map source IDs to booleans");
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
