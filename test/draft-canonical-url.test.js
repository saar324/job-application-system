import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { ApplicationService } from '../src/service.js';
import { DiscoveryService } from '../src/discovery/service.js';
import { draftProfileFingerprint } from '../src/application-drafts.js';
import { draftPacket } from './fixtures/draft-packet.js';

const identity = { actorId: 'fixture-owner', profileId: 'fixture' };
const main = { sessionId: 'fixture-chat' };
const roleId = 'c841cb95-7f6a-4b60-9a1b-97f3849a5f20';
const otherRoleId = 'd38cbdd9-842b-498a-8c37-c848d71f25b0';
const posting = `https://jobs.ashbyhq.com/example/${roleId}?utm_source=test`;
const canonical = `https://jobs.ashbyhq.com/example/${roleId}/application`;

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'draft-canonical-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new JsonStore(path.join(dir, 'state.json')).init();
  const profile = { contact: { firstName: 'Fixture' }, skills: ['Python'],
    preferences: { locations: ['Remote'], fullTime: { remoteOnly: true } } };
  const profiles = { get: async () => structuredClone(profile) };
  const config = { defaultMode: 'full_time', execution: { workflow: 'chrome_session' },
    discovery: { sourceOptions: { ashby: { boards: [{ slug: 'example', company: 'Example' }] } } },
    modes: { full_time: { minimumScore: 0, dailyApplicationCap: 100, sources: ['ashby'] } } };
  const service = new ApplicationService({ store, config, profiles });
  const requests = [];
  const row = { id: roleId, title: 'Senior Engineer', isRemote: true, location: 'Remote',
    descriptionPlain: 'Example production role description.', applyUrl: canonical,
    jobUrl: `https://jobs.ashbyhq.com/example/${roleId}` };
  const discovery = new DiscoveryService({ applicationService: service, profiles, config,
    officialRequestPaceMs: 0, fetchImpl: async url => {
      requests.push(String(url));
      return new Response(JSON.stringify({ jobs: [row] }), { status: 200,
        headers: { 'content-type': 'application/json' } });
    } });
  await service.searchCoordinator.start({ ...main, sources: ['ashby'] }, identity);
  const { lease } = await service.searchCoordinator.claim({ ...main, workerId: 'search-1' }, identity);
  const enqueue = draft => service.searchCoordinator.enqueue({ ...main, workerId: 'search-1',
    leaseId: lease.id, officialPostingReviewed: true, profileFingerprint: draftProfileFingerprint(profile),
    candidate: { source: 'ashby', title: row.title, company: 'Example', description: row.descriptionPlain,
      applyUrl: posting, listingUrl: posting, remote: true, location: 'Remote' },
    fit: { decision: 'relevant', reason: 'Reviewed synthetic fit.' }, draft }, identity, discovery);
  return { service, store, requests, enqueue };
}

test('real official ATS review binds tracked posting draft to canonical application URL', async t => {
  const f = await fixture(t);
  const result = await f.enqueue(draftPacket(posting));
  assert.equal(result.status, 'queued');
  assert.deepEqual(f.requests, ['https://api.ashbyhq.com/posting-api/job-board/example']);
  const loaded = await f.service.applicationDrafts.load(result.applicationId, identity);
  assert.equal(loaded.officialPostingUrl, canonical);
  assert.equal(loaded.packet.officialPostingUrl, canonical);
  assert.equal(loaded.packet.formObservation.url, posting);
  assert.equal(loaded.readyToFill, false);
  assert.equal(f.store.snapshot().attempts.length, 0);
});

test('same ATS host cannot bind a draft for a different role or board', async t => {
  for (const wrong of [`https://jobs.ashbyhq.com/example/${otherRoleId}/application`,
    `https://jobs.ashbyhq.com/alternate/${roleId}/application`]) {
    await t.test(wrong.includes('alternate') ? 'different board' : 'different role', async t => {
      const f = await fixture(t);
      await assert.rejects(f.enqueue(draftPacket(wrong)), /match queued role/);
      assert.equal(f.store.snapshot().applications.length, 0);
      assert.equal(f.store.snapshot().attempts.length, 0);
      assert.equal(f.service.searchCoordinator.status(identity).buffer.pending, 0);
    });
  }
});
