import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { VerificationSessions } from '../worker/verification-sessions.js';

const binding = { profileId: 'synthetic-profile', applicationId: 'synthetic-application', attemptId: 'synthetic-attempt', destination: 'https://example.test/application', previewFingerprint: 'a'.repeat(64) };
const code = 'Code8XYZ';
async function fixture(t, { ttlMs = 1000, failure } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'verification-fixture-'));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body: `<form><input name="name" value="Ada"><button id="initial">Submit application</button></form><script>window.initial=0;window.verification=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.initial++;document.querySelector('form').innerHTML='<label>Security code<input id="security" autocomplete="one-time-code"></label><button id="verify" type="button">Submit application</button>';document.querySelector('#verify').onclick=()=>{window.verification++;if(document.querySelector('#security').value==='${code}')document.body.innerHTML='<h2>Your application was successfully submitted.</h2>';};};</script>` }));
  await page.goto(binding.destination);
  await page.locator('#initial').click();
  let clock = 0, continuationCalls = 0, receipts = 0;
  const sessions = new VerificationSessions({ ttlMs, maxSessions: 3, now: () => clock });
  const retained = sessions.retain({ binding, context, page, continueVerification: async value => {
    continuationCalls++;
    if (failure === 'throw') throw new Error(code);
    if (failure === 'unsafeReceipt') return {status:'submitted',receipt:{finalUrl:binding.destination,code}};
    const transientCode = typeof value === 'string' ? value : value.code;
    await page.locator('#security').fill(transientCode);
    await page.locator('#verify').click();
    if (!(await page.locator('h2').count())) return { status: 'needs_human' };
    return { status: 'submitted', receipt: { submittedAt: new Date().toISOString(), finalUrl: binding.destination, simulated: true } };
  }});
  const metadata = await retained;
  const input = { ...binding, sessionId: metadata.id, code };
  const options = { authorize: async () => ({ allowed: true }), persistReceipt: async result => {
    receipts++;
    await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(result));
  }};
  t.after(async () => { await browser.close(); await rm(directory, { recursive: true, force: true }); });
  return { sessions, page, metadata, input, options, directory, setClock: value => { clock = value; }, counts: () => ({ continuationCalls, receipts }) };
}

test('live same-attempt verification captures a receipt after one initial and one verification action without code persistence', async t => {
  const f = await fixture(t);
  const result = await f.sessions.verify(f.input, f.options);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(f.counts(), { continuationCalls: 1, receipts: 1 });
  assert.deepEqual(await f.page.evaluate(() => [window.initial, window.verification]), [1, 1]);
  assert.equal(JSON.stringify(f.metadata).includes(code), false);
  assert.equal(JSON.stringify(result).includes(code), false);
  for (const file of await readdir(f.directory)) assert.equal((await readFile(path.join(f.directory, file), 'utf8')).includes(code), false);
});

for (const key of ['profileId', 'applicationId', 'attemptId', 'destination', 'previewFingerprint']) {
  test(`verification rejects changed ${key} without invoking continuation or receipt persistence`, async t => {
    const f = await fixture(t);
    await f.sessions.verify({ ...f.input, [key]: 'different' }, f.options).catch(() => undefined);
    assert.deepEqual(f.counts(), { continuationCalls: 0, receipts: 0 });
    assert.deepEqual(await f.page.evaluate(() => [window.initial, window.verification]), [1, 0]);
  });
}

test('expired live session holds without repeating initial Submit', async t => {
  const f = await fixture(t); f.setClock(1001);
  await f.sessions.verify(f.input, f.options).catch(() => undefined);
  assert.deepEqual(f.counts(), { continuationCalls: 0, receipts: 0 });
});

test('process restart cannot revive a lost verification session', async t => {
  const f = await fixture(t);
  const restarted = new VerificationSessions({ ttlMs: 1000, maxSessions: 3 });
  await restarted.verify(f.input, f.options).catch(() => undefined);
  assert.deepEqual(f.counts(), { continuationCalls: 0, receipts: 0 });
});

test('concurrent duplicate verification cannot click twice or persist duplicate receipts', async t => {
  const f = await fixture(t);
  await Promise.allSettled([f.sessions.verify(f.input, f.options), f.sessions.verify(f.input, f.options)]);
  assert.deepEqual(f.counts(), { continuationCalls: 1, receipts: 1 });
});

test('denied current authorization prevents verification action', async t => {
  const f = await fixture(t);
  await f.sessions.verify(f.input, { ...f.options, authorize: async () => ({ allowed: false }) }).catch(() => undefined);
  assert.deepEqual(f.counts(), { continuationCalls: 0, receipts: 0 });
});

test('expiration while authorization is in flight prevents verification callback', async t => {
  const f = await fixture(t);
  const result = await f.sessions.verify(f.input, { ...f.options, authorize: async () => { f.setClock(1001); return { allowed: true }; } });
  assert.equal(result.status, 'needs_human');
  assert.deepEqual(f.counts(), { continuationCalls: 0, receipts: 0 });
});

test('destination changes while authorization is in flight prevent verification callback', async t => {
  const f = await fixture(t);
  await f.sessions.verify(f.input, { ...f.options, authorize: async () => { await f.page.goto('https://example.test/different'); return { allowed: true }; } });
  assert.deepEqual(f.counts(), { continuationCalls: 0, receipts: 0 });
});

for (const invalid of ['', 'short', '123456789', 'abcd ef!']) {
  test(`malformed verification code of length ${invalid.length} never reaches browser`, async t => {
    const f = await fixture(t);
    await f.sessions.verify({ ...f.input, code: invalid }, f.options);
    assert.deepEqual(f.counts(), { continuationCalls: 0, receipts: 0 });
  });
}

for (const failure of ['throw', 'unsafeReceipt']) {
  test(`verification ${failure} hides codes and cannot replay the action`, async t => {
    const f = await fixture(t, { failure });
    const result = await f.sessions.verify(f.input, f.options);
    assert.equal(result.status, 'needs_human');
    assert.equal(JSON.stringify(result).includes(code), false);
    await f.sessions.verify(f.input, f.options);
    assert.deepEqual(f.counts(), { continuationCalls: 1, receipts: 0 });
  });
}

test('verification authority receives only safe bindings and never the transient code', async t => {
  const f = await fixture(t);
  await f.sessions.verify(f.input, { ...f.options, authorize: async input => {
    assert.equal(Object.hasOwn(input, 'code'), false);
    assert.equal(JSON.stringify(input).includes(code), false);
    assert.equal(input.applicationId, binding.applicationId);
    return { allowed: true };
  }});
  assert.deepEqual(f.counts(), { continuationCalls: 1, receipts: 1 });
});
