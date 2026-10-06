import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
export function normalizeCredentialOrigin(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('credential origin must be public HTTPS'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname
    || url.hostname === 'localhost' || url.hostname.endsWith('.local')
    || url.hostname.includes(':') || /^\d+(?:\.\d+){3}$/.test(url.hostname)) {
    throw new Error('credential origin must be public HTTPS');
  }
  return url.origin.toLowerCase();
}

/** Compatible with the original version-1 AES-256-GCM files and profile AAD. */
export class CredentialVault {
  #pending = Promise.resolve();
  constructor({ directory, keys }) {
    this.directory = path.resolve(directory);
    this.keys = new Map(Object.entries(keys ?? {}).map(([id, value]) => {
      const key = Buffer.from(String(value), 'base64');
      if (!SAFE_ID.test(id) || key.length !== 32) throw new Error('invalid credential vault key configuration');
      return [id, key];
    }));
  }
  configured(profileId) { return this.keys.has(profileId); }
  async get(profileId, origin) {
    const normalized = normalizeCredentialOrigin(origin);
    const entries = await this.#read(profileId);
    if (!Object.hasOwn(entries, normalized)) return null;
    const entry = entries[normalized];
    if (typeof entry?.username !== 'string' || typeof entry?.password !== 'string') throw new Error('invalid encrypted account record');
    return { origin: normalized, username: entry.username, password: entry.password,
      generated: entry.generated === true, updatedAt: entry.updatedAt };
  }
  /** Create or reuse, never replace an existing password as a side effect of saving. */
  async save(profileId, origin, credential) {
    const normalized = normalizeCredentialOrigin(origin);
    if (typeof credential?.username !== 'string' || !credential.username.trim() || credential.username.length > 320
      || typeof credential.password !== 'string' || !credential.password || credential.password.length > 4096) {
      throw new Error('account username and password are required and must be bounded');
    }
    const operation = this.#pending.then(async () => {
      const entries = await this.#read(profileId);
      if (Object.hasOwn(entries, normalized)) {
        const old = entries[normalized];
        if (old.username !== credential.username || old.password !== credential.password) {
          throw Object.assign(new Error('existing account credential requires owner-managed update'), { status: 409 });
        }
        return { origin: normalized, saved: true, created: false };
      }
      entries[normalized] = { username: credential.username, password: credential.password,
        generated: credential.generated === true, updatedAt: new Date().toISOString() };
      await this.#write(profileId, entries);
      return { origin: normalized, saved: true, created: true };
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }
  #target(profileId) {
    if (!SAFE_ID.test(profileId ?? '') || !this.keys.has(profileId)) throw new Error('credential vault unavailable for this applicant');
    return { file: path.join(this.directory, `${profileId}.enc.json`), key: this.keys.get(profileId) };
  }
  async #read(profileId) {
    const { file, key } = this.#target(profileId);
    let envelope;
    try { envelope = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('encrypted account vault could not be read'); }
    try {
      if (envelope.version !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(profileId));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const entries = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error();
      return entries;
    } catch { throw new Error('encrypted account vault authentication failed'); }
  }
  async #write(profileId, entries) {
    const { file, key } = this.#target(profileId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(profileId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(entries)), cipher.final()]);
    const envelope = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    const temporary = `${file}.${randomBytes(12).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    await chmod(file, 0o600);
  }
}

export async function credentialVaultFromEnv(env = process.env) {
  const keysFile = env.JOB_SERVER_VAULT_KEYS_FILE
    ?? (env.CREDENTIALS_DIRECTORY ? path.join(env.CREDENTIALS_DIRECTORY, 'job-vault-keys') : undefined);
  if (!keysFile) return undefined;
  try {
    return new CredentialVault({ directory: env.JOB_SERVER_CREDENTIAL_VAULTS ?? '/var/lib/job-application/vaults',
      keys: JSON.parse(await readFile(keysFile, 'utf8')) });
  } catch { throw new Error('credential vault configuration could not be loaded'); }
}
