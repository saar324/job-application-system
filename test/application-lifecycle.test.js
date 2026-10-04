import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/sqlite-store.js';
import { ApplicationService } from '../src/service.js';
import { inactivityDeadline, trackingStatus } from '../src/application-lifecycle.js';

const start = '2026-01-01T12:00:00.000Z';
const deadline = '2026-01-22T12:00:00.000Z';
const later = '2026-01-22T12:00:00.001Z';
const owner = { profileId: 'applicant', actorId: 'owner' };
const application = (extra = {}) => ({ id: 'a', profileId: owner.profileId, opportunityId: 'o',
  status: 'submitted', createdAt: start, updatedAt: start, receipt: { submittedAt: start, manuallyVerified: true }, ...extra });
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'inactivity-'));
  const file = path.join(dir, 'state.sqlite');
  const store = await new SqliteStore(file).init();
  await store.mutate(state => {
    state.opportunities.push({ id: 'o', profileId: owner.profileId, title: 'Engineer', company: 'Example', createdAt: start });
    state.applications.push(application());
  });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, file, service: new ApplicationService({ store, config: {}, profiles: {} }) };
}

test('strictly more than 21 days, durable closure, receipt preservation and idempotency', async t => {
  const { store, service, file } = await fixture(t);
  assert.equal((await service.reconcileInactivity(deadline)).closed, 0);
  assert.equal((await service.reconcileInactivity(later)).closed, 1);
  assert.equal((await service.reconcileInactivity(later)).closed, 0);
  const saved = service.list('applications', owner.profileId)[0];
  assert.equal(saved.status, 'submitted');
  assert.equal(saved.receipt.submittedAt, start);
  assert.equal(saved.trackingStatus, 'auto_closed');
  assert.equal(service.applicationLog(owner.profileId)[0].trackingStatus, 'auto_closed');
  assert.equal(saved.employerStatus, undefined);
  assert.equal(store.snapshot().audit.length, 1);
  const reopenedStore = await new SqliteStore(file).init();
  assert.equal(reopenedStore.snapshot().applications[0].lifecycle.status, 'auto_closed');
  reopenedStore.close();
  assert.equal(service.list('applications', 'other').length, 0);
});

test('meaningful delayed reply reopens without comparing against automatic closure time', async t => {
  const { store, service } = await fixture(t);
  await service.reconcileInactivity(later);
  const input = { status: 'interview', observedAt: '2026-01-20T12:00:00.000Z', sourceId: 'reply', source: 'email' };
  const reply = await service.recordEmployerStatus('a', input, owner);
  assert.equal(reply.trackingStatus, 'interview');
  assert.equal(reply.lifecycle.status, 'reopened');
  assert.equal(reply.receipt.submittedAt, start);
  await service.recordEmployerStatus('a', input, owner);
  assert.equal(store.snapshot().audit.filter(a => a.action === 'application.inactivity_reopened').length, 1);
  assert.equal((await service.reconcileInactivity('2026-12-31T12:00:00Z')).closed, 0);
  await assert.rejects(service.recordEmployerStatus('a', input, { profileId: 'other' }), /not found/);
});

test('receipt acknowledgements do not restart clock or reopen a silent application', async t => {
  const { service } = await fixture(t);
  await service.recordEmployerStatus('a', { status: 'application_received', observedAt: '2026-01-20T12:00:00Z', sourceId: 'receipt' }, owner);
  assert.equal((await service.reconcileInactivity(later)).closed, 1);
  await service.recordEmployerStatus('a', { status: 'application_received', observedAt: '2026-01-25T12:00:00Z', sourceId: 'duplicate-receipt' }, owner);
  assert.equal(service.applicationLog(owner.profileId)[0].trackingStatus, 'auto_closed');
});

test('substantive review update starts a new 21-day waiting period', async t => {
  const { service } = await fixture(t);
  await service.recordEmployerStatus('a', { status: 'under_review', observedAt: '2026-01-20T12:00:00Z', sourceId: 'review' }, owner);
  assert.equal((await service.reconcileInactivity(later)).closed, 0);
  assert.equal((await service.reconcileInactivity('2026-02-10T12:00:00.001Z')).closed, 1);
  await service.recordEmployerStatus('a', { status: 'under_review', observedAt: '2026-02-11T12:00:00Z', sourceId: 'new-review' }, owner);
  assert.equal(service.applicationLog(owner.profileId)[0].trackingStatus, 'under_review');
});

test('protects actionable stages, final outcomes, unverified attempts and bad receipt dates', () => {
  for (const status of ['action_required', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn', 'closed', 'hired']) {
    assert.equal(inactivityDeadline(application({ employerStatus: { status, observedAt: start } })), null);
  }
  for (const receipt of [undefined, { submittedAt: 'invalid' }, { submittedAt: start, simulated: true }]) {
    assert.equal(inactivityDeadline(application({ receipt })), null);
  }
  for (const status of ['waiting_confirmation', 'submission_unverified', 'waiting_owner', 'pending', 'failed', 'skipped']) {
    assert.equal(inactivityDeadline(application({ status })), null);
  }
  assert.equal(inactivityDeadline(application()), deadline);
  assert.equal(trackingStatus(application({ employerStatus: { status: 'withdrawn' }, lifecycle: { status: 'auto_closed' } })), 'withdrawn');
});
