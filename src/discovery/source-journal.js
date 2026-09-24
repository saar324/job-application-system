import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class SourceJournal {
  constructor({ campaignId, sourceId, directory = path.join(os.homedir(),
    ".local", "state", "job-application", "source-progress") }) {
    if (!/^[a-z0-9_-]{1,100}$/i.test(campaignId)
      || !/^[a-z0-9_-]{1,80}$/i.test(sourceId)) {
      throw new Error("source journal requires safe campaign and source IDs");
    }
    this.directory = directory;
    this.campaignId = campaignId;
    this.sourceId = sourceId;
    const name = createHash("sha256").update(`${campaignId}:${sourceId}`).digest("hex");
    this.file = path.join(directory, `${name}.json`);
  }

  async load() {
    let body;
    try { body = JSON.parse(await readFile(this.file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    if (body.campaignId !== this.campaignId || body.sourceId !== this.sourceId
      || !Array.isArray(body.pending) || body.pending.length > 100
      || body.pending.some((item) => !item || typeof item !== "object"
        || typeof item.title !== "string" || typeof item.company !== "string"
        || typeof item.applyUrl !== "string")) {
      throw new Error("source journal is invalid");
    }
    return body.pending;
  }

  async save(pending) {
    if (!pending.length) return rm(this.file, { force: true });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ campaignId: this.campaignId,
        sourceId: this.sourceId, pending }), { mode: 0o600 });
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }

  async clear() { await rm(this.file, { force: true }); }
}
