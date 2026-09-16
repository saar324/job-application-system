import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = { opportunities: [], applications: [], confirmations: [], audit: [] };

export class JsonStore {
  #file;
  #state;
  #pending = Promise.resolve();

  constructor(file) { this.#file = path.resolve(file); }

  async init() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      this.#state = JSON.parse(await readFile(this.#file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
    }
    return this;
  }

  snapshot() { return structuredClone(this.#state); }

  async mutate(fn) {
    const operation = this.#pending.then(async () => {
      const draft = structuredClone(this.#state);
      const result = await fn(draft);
      this.#state = draft;
      await this.#persist();
      return structuredClone(result);
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  async #persist() {
    const temporary = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#file);
  }
}
