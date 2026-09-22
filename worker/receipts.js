import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function fingerprint(payload) {
  return createHash("sha256").update(stableJson({
    application: payload.application,
    profile: payload.profile,
    opportunity: payload.opportunity
  })).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class ReceiptStore {
  #inFlight = new Map();

  constructor(directory) { this.directory = path.resolve(directory); }

  async run(payload, submit) {
    const id = payload.application.id;
    const hash = fingerprint(payload);
    const current = this.#inFlight.get(id);
    if (current) {
      if (current.fingerprint !== hash) return changedPayload();
      return current.promise;
    }
    const promise = this.#run(id, hash, submit).finally(() => this.#inFlight.delete(id));
    this.#inFlight.set(id, { fingerprint: hash, promise });
    return promise;
  }

  async #run(id, hash, submit) {
    await mkdir(this.directory, { recursive: true, mode: 0o750 });
    const file = path.join(this.directory, `${id}.json`);
    const existing = await readFile(file, "utf8").then(JSON.parse).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing) return existing.fingerprint === hash ? existing.result : changedPayload();
    const result = await submit();
    if (result.status === "submitted") {
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ fingerprint: hash, result }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file);
    }
    return result;
  }
}

function changedPayload() {
  return {
    status: "needs_human",
    message: "This application ID was already used with different submission data",
    requirements: [{
      kind: "idempotency_conflict", action: "manual_review",
      message: "Verify the existing application before taking any further action"
    }]
  };
}
