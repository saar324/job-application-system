import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/sqlite-store.js';
import { ApplicationService } from '../src/service.js';
import { SearchCoordinator } from '../src/discovery/search-coordinator.js';
import { validateDraft, draftProfileFingerprint } from '../src/application-drafts.js';
import { buildFillPlan } from '../skills/job-application/scripts/draft-fill-plan.js';
import { draftPacket } from './fixtures/draft-packet.js';
import { createHttpServer } from '../src/http.js';

const owner = { actorId: 'fixture-owner', profileId: 'fixture' }, main = { sessionId: 'fixture-chat' };
async function fixture(t, count = 0) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'draft-buffer-'));
  const file = path.join(dir, 'state.sqlite');
  const store = await new SqliteStore(file).init();
  let profile = { contact: { firstName: 'Fixture' }, applicationAnswers: { availability: 'Immediate' } };
  const config = { defaultMode: 'full_time', execution: { workflow: 'chrome_session' }, modes: { full_time: { dailyApplicationCap: 100 } } };
  const profiles = { get: async () => structuredClone(profile) };
  const service = new ApplicationService({ store, config, profiles });
  const discovery = { considerCandidate: async input => {
    const o = await service.addOpportunity(input.candidate, owner, { reviewedDiscovery: true });
    return { status: 'ready', opportunityId: o.id };
  } };
  for (let i = 0; i < count; i++) await service.chromeQueue.add({ url: `https://employer.example/job/${i}` }, owner);
  await service.searchCoordinator.start({ ...main, sources: ['alpha', 'beta'] }, owner);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const enqueue = (lease, n, provider = discovery, coordinator = service.searchCoordinator) => coordinator.enqueue({ ...main,
    workerId: lease.workerId, leaseId: lease.id, officialPostingReviewed: true,
    candidate: { source: lease.sourceId, company: 'Fixture', title: `Engineer ${n}`, description: 'Full remote role', applyUrl: `https://employer.example/new/${n}` },
    fit: { decision: 'relevant', reason: 'Matches verified experience' },
    draft: draftPacket(`https://employer.example/new/${n}`), profileFingerprint: draftProfileFingerprint(profile) }, owner, provider);
  return { store, file, service, profiles, discovery, config, enqueue, setProfile: p => { profile = p; } };
}

test('20/30 hysteresis persists across restart and does not change FIFO or count active forms', async t => {
  const f = await fixture(t, 20), c = f.service.searchCoordinator;
  const lease = (await c.claim({ ...main, workerId: 'search-1' }, owner)).lease;
  for (let i = 0; i < 10; i++) await f.enqueue(lease, i);
  assert.equal(c.status(owner).buffer.pending, 30);
  assert.equal(c.status(owner).buffer.shouldSearch, false);
  const before = f.service.chromeQueue.list(owner.profileId).items.map(a => a.id);
  await f.service.chromeQueue.claim(main, owner);
  assert.equal((await c.control(main, owner)).buffer.pending, 29);
  assert.equal((await c.claim({ ...main, workerId: 'search-2' }, owner)).lease, null);
  const restarted = new SearchCoordinator(f.service);
  assert.equal(restarted.status(owner).buffer.refilling, false);
  for (let i = 0; i < 9; i++) {
    const active = f.service.chromeQueue.list(owner.profileId).current;
    await f.service.chromeQueue.skip(active.id, { ...main, reason: 'Synthetic completed queue item' }, owner);
    await f.service.chromeQueue.claim(main, owner);
  }
  const b = (await restarted.control(main, owner)).buffer;
  assert.equal(b.pending, 20); assert.equal(b.shouldSearch, true); assert.equal(b.cycle, 2);
  assert.ok((await restarted.claim({ ...main, workerId: 'search-2' }, owner)).lease);
  assert.deepEqual(f.service.chromeQueue.list(owner.profileId).items.map(a => a.id), before);
  assert.equal(f.store.snapshot().attempts.length, 0);
});

test('two independent SQLite connections race for slot 30 and only one can append', async t => {
  const f = await fixture(t, 20), c = f.service.searchCoordinator;
  const a = (await c.claim({ ...main, workerId: 'search-1' }, owner)).lease;
  const b = (await c.claim({ ...main, workerId: 'search-2' }, owner)).lease;
  for (let i = 0; i < 9; i++) await f.enqueue(a, i);
  const second = await new SqliteStore(f.file).init(); t.after(() => second.close());
  const c2 = new ApplicationService({ store: second, config: f.config, profiles: f.profiles }).searchCoordinator;
  // Discovery overlaps before the two independently queued SQLite transactions.
  const results = await Promise.allSettled([f.enqueue(a, 100), f.enqueue(b, 101, f.discovery, c2)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /buffer full/);
  assert.equal(f.service.chromeQueue.list(owner.profileId).pending, 30);
  assert.equal(c.status(owner).buffer.shouldStopWorkers, true);
  assert.equal((await c.prepareClaim({ ...main, workerId: 'search-1' }, owner)).lease, null);
});

test('backfill leases are exclusive, do not claim forms, and cannot write after main claims the job', async t => {
  const f = await fixture(t, 20), c = f.service.searchCoordinator;
  const [a,b] = await Promise.all(['search-1','search-2'].map(workerId => c.prepareClaim({ ...main, workerId }, owner)));
  assert.notEqual(a.applicationId, b.applicationId);
  assert.equal(f.service.chromeQueue.list(owner.profileId).current, null);
  await c.prepareSave({ ...main, workerId: 'search-2', leaseId: b.lease.id, applicationId: b.applicationId,
    profileFingerprint: b.profileFingerprint, draft: draftPacket(b.opportunity.applyUrl) }, owner);
  assert.equal((await f.service.applicationDrafts.load(b.applicationId, owner)).status, 'unreviewed');
  assert.equal(f.service.chromeQueue.list(owner.profileId).pending, 20);
  await f.service.chromeQueue.claim(main, owner);
  await assert.rejects(c.prepareSave({ ...main, workerId: 'search-1', leaseId: a.lease.id, applicationId: a.applicationId,
    profileFingerprint: a.profileFingerprint, draft: draftPacket(a.opportunity.applyUrl) }, owner), /already claimed/);
  assert.equal(f.store.snapshot().attempts.length, 0);
});

test('main corrects one loaded packet before batch planning, then live review remains mandatory', async t => {
  const f = await fixture(t), c = f.service.searchCoordinator;
  const lease = (await c.claim({ ...main, workerId: 'search-1' }, owner)).lease;
  const { applicationId } = await f.enqueue(lease, 1);
  await f.service.chromeQueue.claim(main, owner);
  const d = await f.service.applicationDrafts.load(applicationId, owner);
  assert.equal(d.readyToFill, false);
  const packet = structuredClone(d.packet); packet.fields[0].value = 'Corrected Fixture'; packet.fields[0].required = true;
  packet.formObservation.complete = true; packet.formObservation.access = 'public';
  await assert.rejects(f.service.applicationDrafts.review(applicationId, { ...main, sessionId: 'other', revision: d.revision, fingerprint: d.fingerprint, packet }, owner), /current main/);
  const review = await f.service.applicationDrafts.review(applicationId, { ...main, revision: d.revision, fingerprint: d.fingerprint, packet }, owner);
  assert.equal(review.readyToFill, true);
  const loaded = await f.service.applicationDrafts.load(applicationId, owner);
  const plan = buildFillPlan({ draft: loaded, live: { url: loaded.officialPostingUrl, observedAt: new Date().toISOString(),
    fields: [{ key: 'first_name_live', question: 'First Name *', kind: 'text', required: true, locator: { by: 'role', role: 'textbox', value: 'First Name *' } }] } });
  assert.equal(plan.fields[0].value, 'Corrected Fixture'); assert.equal(plan.readyForBatchFill, true);
  assert.equal(plan.requiresLiveVerification, true); assert.equal(plan.submissionAuthorized, false);
  await assert.rejects(f.service.chromeQueue.startSubmission(applicationId, { ...main, previewFingerprint: 'draft' }, owner), /complete current review/);
  f.setProfile({ contact: { firstName: 'New Fact' } });
  const stale = await f.service.applicationDrafts.load(applicationId, owner);
  assert.equal(stale.stale.profileChanged, true); assert.equal(stale.readyToFill, false);
  assert.throws(() => buildFillPlan({ draft: stale, live: {} }), /correct/);
  await assert.rejects(f.service.applicationDrafts.review(applicationId, { ...main, revision: d.revision, fingerprint: d.fingerprint, packet }, owner), /reload/);
});

test('drafts reject operational authority, credentials, wrong jobs, missing provenance and prohibited writing', async t => {
  assert.throws(() => validateDraft({ ...draftPacket(), submitted: true }), /structure/);
  const credential = draftPacket(); credential.fields[0].question = 'Password'; assert.throws(() => validateDraft(credential), /credentials/);
  const unsupported = draftPacket(); unsupported.fields[0].evidence = []; assert.throws(() => validateDraft(unsupported), /provenance/);
  const banned = draftPacket(); banned.coverLetter.text = 'Generated prose'; banned.coverLetter.aiPolicy = 'prohibited'; assert.throws(() => validateDraft(banned), /writing policy/);
  const f = await fixture(t, 1), c = f.service.searchCoordinator, a = await c.prepareClaim({ ...main, workerId: 'search-1' }, owner);
  await assert.rejects(c.prepareSave({ ...main, workerId: 'search-1', leaseId: a.lease.id, applicationId: a.applicationId,
    profileFingerprint: a.profileFingerprint, draft: draftPacket('https://different.example/job') }, owner), /match queued/);
  await assert.rejects(f.service.applicationDrafts.load(a.applicationId, { ...owner, profileId: 'other' }), /not found/);
});

test('HTTP exposes one profile bound draft packet and correction routes without submission or accounts', async t => {
  const f = await fixture(t, 1);
  const server = createHttpServer({ service: f.service, profiles: f.profiles, discovery: f.discovery, config: f.config,
    authenticate: req => req.headers.authorization === 'Bearer fixture' ? owner : null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json' };
  const post = (route, body) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  const context = await (await fetch(base + '/v1/draft-context', { headers })).json();
  assert.equal(context.facts.contact.firstName, 'Fixture'); assert.ok(context.profileFingerprint);
  const a = await (await post('/v1/discovery/search/prepare-claim', { ...main, workerId: 'search-1' })).json();
  assert.equal((await post('/v1/discovery/search/prepare-save', { ...main, workerId: 'search-1', leaseId: a.lease.id,
    applicationId: a.applicationId, profileFingerprint: context.profileFingerprint, draft: draftPacket(a.opportunity.applyUrl) })).status, 200);
  const draft = await (await fetch(base + `/v1/chrome-queue/${a.applicationId}/draft`, { headers })).json();
  assert.equal(draft.packet.fields[0].value, 'Fixture'); assert.equal(draft.readyToFill, false);
  assert.equal((await fetch(base + `/v1/chrome-queue/${a.applicationId}/draft`)).status, 401);
  assert.equal((await post('/v1/discovery/search/control', main)).status, 200);
});
