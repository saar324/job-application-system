import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CredentialVault, credentialVaultFromEnv } from '../src/credential-vault.js';
import { ApplicationService } from '../src/service.js';
import { JsonStore } from '../src/store.js';
import { createHttpServer } from '../src/http.js';
import { consumeAccountFile, readPrivateAccountFile } from '../skills/job-application/scripts/account-file.js';

const run = promisify(execFile);
const owner = { actorId: 'fixture-agent', profileId: 'applicant-one' };
const input = { sessionId: 'fixture-chat', origin: 'https://employer.example' };
const credential = { username: 'applicant@example.test', password: 'synthetic-test-password' };
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'account-access-test-'));
  const keys = { 'applicant-one': randomBytes(32).toString('base64'), 'applicant-two': randomBytes(32).toString('base64') };
  const vault = new CredentialVault({ directory: dir, keys });
  const store = await new JsonStore(path.join(dir, 'state.json')).init();
  const service = new ApplicationService({ store, credentialVault: vault,
    config: { defaultMode: 'full_time', execution: { workflow: 'chrome_session' }, modes: { full_time: {} } } });
  const id = (await service.chromeQueue.add({ url: 'https://employer.example/jobs/1' }, owner)).application.id;
  await service.chromeQueue.claim(input, owner);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, keys, vault, store, service, id, access: (action, body = input, identity = owner) => service.accountAccess.run(action, id, body, identity) };
}

test('original encrypted format unlocks without rewriting and remains profile-bound', async t => {
  const f = await fixture(t);
  const iv = randomBytes(12), key = Buffer.from(f.keys[owner.profileId], 'base64');
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(owner.profileId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ [input.origin]: { ...credential, generated: true } })), cipher.final()]);
  const file = path.join(f.dir, `${owner.profileId}.enc.json`);
  await writeFile(file, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }), { mode: 0o600 });
  const before = await readFile(file);
  assert.deepEqual(await f.access('status'), { configured: true, available: true, origin: input.origin });
  assert.equal((await f.access('access')).password, credential.password);
  assert.deepEqual(await readFile(file), before);
  await assert.rejects(f.access('access', input, { ...owner, profileId: 'applicant-two' }), /not found/);
  assert.equal(await f.vault.get('applicant-two', input.origin), null);
  const wrongVault = new CredentialVault({ directory: f.dir, keys: { [owner.profileId]: randomBytes(32).toString('base64') } });
  await assert.rejects(wrongVault.get(owner.profileId, input.origin), /authentication failed/);
});

test('saved accounts are encrypted, reusable, never overwritten and absent from queue/history/audit', async t => {
  const f = await fixture(t);
  assert.equal((await f.access('status')).available, false);
  await assert.rejects(f.access('store', { ...input, ...credential }), /storage authorization/);
  const saved = { ...input, ...credential, storageAuthorization: 'Owner authorized encrypted storage for this employer in this chat' };
  assert.equal((await f.access('store', saved)).created, true);
  assert.equal((await f.access('store', saved)).created, false);
  await assert.rejects(f.access('store', { ...saved, password: 'different-test-password' }), /owner-managed update/);
  assert.equal((await f.access('access')).password, credential.password);
  const file = path.join(f.dir, `${owner.profileId}.enc.json`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes(credential.password) && !raw.includes(credential.username));
  const history = JSON.stringify(f.store.snapshot());
  assert.ok(!history.includes(credential.password) && !history.includes(credential.username));
});

test('account requests enforce current session, exact HTTPS origin and final outcome hold', async t => {
  const f = await fixture(t); await f.vault.save(owner.profileId, input.origin, credential);
  const embeddedCredentialUrl = new URL(input.origin); embeddedCredentialUrl.username = 'synthetic'; embeddedCredentialUrl.password = 'synthetic';
  for (const origin of ['https://other.example', 'https://sub.employer.example', 'https://employer.example:444', 'http://employer.example', embeddedCredentialUrl.toString(), 'https://127.0.0.1']) {
    await assert.rejects(f.access('access', { ...input, origin }), /origin/);
  }
  await assert.rejects(f.access('access', { ...input, sessionId: 'other-chat' }), /does not own/);
  await assert.rejects(f.access('access', input, { ...owner, actorId: 'other-agent' }), /does not own/);
  await assert.rejects(f.access('access', { ...input, profileId: owner.profileId }), /unsupported/);
  await f.store.mutate(state => { state.applications.find(a => a.id === f.id).status = 'submission_unverified'; });
  await assert.rejects(f.access('access'), /uncertain/);
});

test('missing configuration and damaged ciphertext fail closed without secret-bearing errors', async t => {
  const f = await fixture(t);
  f.service.accountAccess.vault = undefined;
  assert.equal((await f.access('status')).configured, false);
  await assert.rejects(f.access('access'), /not configured/);
  assert.equal(await credentialVaultFromEnv({}), undefined);
  f.service.accountAccess.vault = f.vault;
  await f.vault.save(owner.profileId, input.origin, credential);
  const file = path.join(f.dir, `${owner.profileId}.enc.json`);
  const envelope = JSON.parse(await readFile(file, 'utf8')); envelope.tag = randomBytes(16).toString('base64');
  await writeFile(file, JSON.stringify(envelope));
  await assert.rejects(f.access('access'), /could not be unlocked/);
});

test('private handoff is consumed once and rejects wrong browser origins, expiry and public files', async t => {
  const f = await fixture(t), file = path.join(f.dir, 'handoff.json');
  const write = (extra = {}, mode = 0o600) => writeFile(file, JSON.stringify({ ...credential, ...input, expiresAt: new Date(Date.now() + 120000).toISOString(), ...extra }), { mode });
  await write(); assert.deepEqual(await consumeAccountFile(file, 'https://employer.example/login'), credential);
  await assert.rejects(readFile(file), /ENOENT/);
  await write(); await assert.rejects(consumeAccountFile(file, 'https://evil.example'), /does not match/);
  await assert.rejects(readFile(file), /ENOENT/);
  await write({ expiresAt: '2020-01-01' }); await assert.rejects(consumeAccountFile(file, input.origin), /expired/);
  await write({}, 0o644); await assert.rejects(readPrivateAccountFile(file), /private regular file/);
  await symlink(file, path.join(f.dir, 'symlink.json')); await assert.rejects(readPrivateAccountFile(path.join(f.dir, 'symlink.json')));
});

test('authenticated account HTTP transport is non-cacheable, rejects other profiles and CLI never prints passwords', async t => {
  const f = await fixture(t); await f.vault.save(owner.profileId, input.origin, credential);
  const server = createHttpServer({ service: f.service, authenticate: req => req.headers.authorization === 'Bearer fixture-only' ? owner : null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/v1/chrome-queue/${f.id}/account/access`;
  const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer fixture-only', 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).password, credential.password);
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const script = path.resolve('skills/job-application/scripts/jobctl.js');
  const child = await run(process.execPath, ['-e', `process.argv=[process.execPath,${JSON.stringify(script)},'account-download',${JSON.stringify(f.id)}]; const {Readable}=await import('node:stream'); Object.defineProperty(process,'stdin',{value:Readable.from([Buffer.from(${JSON.stringify(JSON.stringify(input))})])}); await import(${JSON.stringify(script)});`],
    { env: { ...process.env, JOB_SERVER_URL: base, JOB_SERVER_TOKEN: 'fixture-only' } });
  assert.ok(!child.stdout.includes(credential.password) && !child.stderr.includes(credential.password));
  const meta = JSON.parse(child.stdout), handoff = await readPrivateAccountFile(meta.path);
  assert.equal(handoff.password, credential.password);
  await consumeAccountFile(meta.path, input.origin);
  await rm(path.dirname(meta.path), { recursive: true, force: true });
});

test('deployment environment update preserves encrypted vault paths and removes retired worker settings', async t => {
  const f = await fixture(t), file = path.join(f.dir, 'server.env');
  await writeFile(file, 'JOB_SERVER_ALLOWED_DOCUMENT_ROOTS=/private/documents\nJOB_SERVER_VAULT_KEYS_FILE=/private/existing-keys.json\nJOB_SERVER_CREDENTIAL_VAULTS=/private/existing-vault\nWORKER_ENDPOINT=http://retired.example\n', { mode: 0o600 });
  await run(process.execPath, ['scripts/update-production-env.js', file]);
  const value = await readFile(file, 'utf8');
  assert.ok(value.includes('JOB_SERVER_VAULT_KEYS_FILE=/private/existing-keys.json'));
  assert.ok(value.includes('JOB_SERVER_CREDENTIAL_VAULTS=/private/existing-vault'));
  assert.ok(!value.includes('WORKER_ENDPOINT'));
});
