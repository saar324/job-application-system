import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export function normalizeCredentialOrigin(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("credential origins must use HTTPS");
  return url.origin.toLowerCase();
}

export function generateManagedPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%_-";
  const bytes = randomBytes(30);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}

export class CredentialVault {
  #pending = Promise.resolve();

  constructor({ directory, keys }) {
    this.directory = path.resolve(directory);
    this.keys = new Map(Object.entries(keys ?? {}).map(([id, value]) => [id, decodeKey(value)]));
  }

  async get(profileId, origin) {
    const normalized = normalizeCredentialOrigin(origin);
    const entries = await this.#read(profileId);
    const credential = entries[normalized];
    return credential ? structuredClone({ ...credential, origin: normalized }) : null;
  }

  async set(profileId, origin, credential) {
    if (!credential?.username || !credential?.password) throw new Error("credential username and password are required");
    const normalized = normalizeCredentialOrigin(origin);
    return this.#mutate(profileId, (entries) => {
      entries[normalized] = {
        username: String(credential.username), password: String(credential.password),
        generated: credential.generated === true, updatedAt: new Date().toISOString()
      };
      return { origin: normalized, username: String(credential.username), generated: credential.generated === true };
    });
  }

  async ensureGenerated(profileId, origin, username) {
    const existing = await this.get(profileId, origin);
    if (existing) return existing;
    await this.set(profileId, origin, { username, password: generateManagedPassword(), generated: true });
    return this.get(profileId, origin);
  }

  async #mutate(profileId, fn) {
    const operation = this.#pending.then(async () => {
      const entries = await this.#read(profileId);
      const result = await fn(entries);
      await this.#write(profileId, entries);
      return result;
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  async #read(profileId) {
    const { file, key } = this.#target(profileId);
    let envelope;
    try { envelope = JSON.parse(await readFile(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
    if (envelope.version !== 1) throw new Error("unsupported credential vault version");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(profileId));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  }

  async #write(profileId, entries) {
    const { file, key } = this.#target(profileId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(profileId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(entries)), cipher.final()]);
    const envelope = {
      version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }

  #target(profileId) {
    if (!SAFE_ID.test(profileId ?? "")) throw new Error("invalid credential vault profile ID");
    const key = this.keys.get(profileId);
    if (!key) throw new Error(`credential vault key is not configured for profile ${profileId}`);
    return { file: path.join(this.directory, `${profileId}.enc.json`), key };
  }
}

function decodeKey(value) {
  const key = Buffer.from(String(value), "base64");
  if (key.length !== 32) throw new Error("credential vault keys must be 32-byte base64 values");
  return key;
}

export async function credentialVaultFromEnv(env = process.env) {
  const credentialsDirectory = env.CREDENTIALS_DIRECTORY;
  const keysFile = env.JOB_SERVER_VAULT_KEYS_FILE
    ?? (credentialsDirectory ? path.join(credentialsDirectory, "job-vault-keys") : undefined);
  if (!keysFile) return undefined;
  const keys = JSON.parse(await readFile(keysFile, "utf8"));
  return new CredentialVault({
    directory: env.JOB_SERVER_CREDENTIAL_VAULTS ?? "/var/lib/job-application/vaults",
    keys
  });
}
