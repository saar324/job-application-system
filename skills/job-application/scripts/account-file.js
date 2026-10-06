import { open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export async function readPrivateAccountFile(file) {
  if (!path.isAbsolute(file)) throw new Error('account file must use an absolute path');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 16_384
      || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('account file must be a private regular file');
    try { return JSON.parse(await handle.readFile('utf8')); }
    catch { throw new Error('private account file could not be read'); }
  } finally { await handle.close(); }
}

/** Call inside the browser tool runtime, never print the returned value. */
export async function consumeAccountFile(file, liveUrl) {
  let value;
  try {
    value = await readPrivateAccountFile(file);
    const live = new URL(liveUrl);
    if (live.protocol !== 'https:' || live.username || live.password || value.origin !== live.origin
      || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()
      || typeof value.username !== 'string' || typeof value.password !== 'string') {
      throw new Error('account handoff expired or does not match this browser origin');
    }
    return { username: value.username, password: value.password };
  } finally {
    // Delete only a regular private handoff, never an arbitrary path/symlink.
    if (value) await unlink(file);
  }
}
