import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStore } from '../src/store.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { ApplicationService } from '../src/service.js';
import { SearchCoordinator } from '../src/discovery/search-coordinator.js';
import { createHttpServer } from '../src/http.js';

const owner = { actorId: 'owner-runtime', profileId: 'fixture' };
const other = { actorId: 'owner-runtime', profileId: 'other-fixture' };
const main = { sessionId: 'main-chat' };
const start = { ...main, sources: ['alpha', 'beta', 'gamma'] };
const scope = (lease, workerId) => ({ ...main, workerId, leaseId: lease.id });
async function fixture(t, kind = 'sqlite') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'search-coordinator-'));
  const file = path.join(dir, `state.${kind}`);
  const store = await (kind === 'sqlite' ? new SqliteStore(file) : new JsonStore(file)).init();
  const config = { defaultMode: 'full_time', execution: { workflow: 'chrome_session' }, modes: { full_time: { dailyApplicationCap: 100 } } };
  const service = new ApplicationService({ store, config, profiles: { get: async () => ({}) } });
  let time = Date.parse('2026-10-07T08:00:00Z');
  const coordinator = new SearchCoordinator(service, { clock: () => time }); service.searchCoordinator = coordinator;
  const discovery = { considerCandidate: async input => {
    assert.equal(input.apply, false);
    const opportunity = await service.addOpportunity({ ...input.candidate, fitAssessment: input.fit }, owner, { reviewedDiscovery: true });
    return { status: 'ready', opportunityId: opportunity.id };
  } };
  t.after(async () => { store.close?.(); await rm(dir, { recursive: true, force: true }); });
  return { store, service, coordinator, config, discovery, file, setTime: value => { time = Date.parse(value); } };
}

for (const kind of ['json', 'sqlite']) {
  test(`${kind}: simultaneous workers receive exclusive ranked sources; restart preserves them`, async t => {
    const f = await fixture(t, kind); await f.coordinator.start(start, owner);
    const [a,b] = await Promise.all(['search-1','search-2'].map(workerId => f.coordinator.claim({ ...main, workerId }, owner)));
    assert.deepEqual([a.lease.sourceId,b.lease.sourceId], ['alpha','beta']);
    assert.equal((await f.coordinator.claim({ ...main, workerId: 'search-1' }, owner)).lease.id, a.lease.id);
    await assert.rejects(f.coordinator.claim({ ...main, workerId: 'search-3' }, owner), /search-1 or search-2/);
    const reopened = await (kind === 'sqlite' ? new SqliteStore(f.file) : new JsonStore(f.file)).init();
    assert.equal(new SearchCoordinator({ ...f.service, store: reopened }, { clock: () => Date.parse('2026-10-07T08:00:00Z') }).status(owner).session.sources[0].lease.id, a.lease.id);
    reopened.close?.();
    const x = scope(a.lease,'search-1');
    await f.coordinator.progress({ ...x, reviewed: 5, duplicates: 3, pageComplete: true, cursor: 'page=2' }, owner);
    await assert.rejects(f.coordinator.finish({ ...x, outcome: 'low_quality', reason: 'One weak page' }, owner), /two focused pages/);
    await f.coordinator.progress({ ...x, reviewed: 4, pageComplete: true }, owner);
    await f.coordinator.finish({ ...x, outcome: 'low_quality', reason: 'Two focused pages had no unseen strong matches' }, owner);
    assert.equal((await f.coordinator.claim({ ...main, workerId: 'search-1' }, owner)).lease.sourceId, 'gamma');
    assert.equal(f.store.snapshot().applications.length, 0);
  });
  test(`${kind}: each Sofia day reopens priority without erasing job history or overlapping midnight workers`, async t => {
    const f = await fixture(t, kind); f.setTime('2026-10-07T20:50:00Z');
    await f.coordinator.start(start, owner);
    const a = (await f.coordinator.claim({ ...main, workerId: 'search-1' }, owner)).lease;
    const b = (await f.coordinator.claim({ ...main, workerId: 'search-2' }, owner)).lease;
    await f.service.chromeQueue.add({ url: 'https://employer.example/job' }, owner);
    await f.coordinator.finish({ ...scope(b,'search-2'), outcome: 'pass_complete', reason: 'Bounded pass finished' }, owner);
    f.setTime('2026-10-07T21:01:00Z');
    const next = await f.coordinator.claim({ ...main, workerId: 'search-2' }, owner);
    assert.equal(next.day, '2026-10-08'); assert.equal(next.lease.sourceId, 'beta');
    assert.equal((await f.coordinator.claim({ ...main, workerId:'search-1' }, owner)).lease.id, a.id);
    await f.coordinator.finish({ ...scope(a,'search-1'), outcome:'pass_complete', reason:'Old-day pass finished' }, owner);
    assert.equal((await f.coordinator.claim({ ...main, workerId:'search-1' }, owner)).lease.sourceId, 'alpha');
    assert.equal(f.store.snapshot().applications.length, 1);
    f.setTime('2026-10-25T22:10:00Z');
    assert.equal(f.coordinator.status(owner).session.day, '2026-10-26', 'uses Sofia DST rules');
  });
}

test('SQLite transactions prevent overlapping leases across independent API connections', async t => {
  const f = await fixture(t); await f.coordinator.start(start, owner);
  const second = await new SqliteStore(f.file).init(); t.after(() => second.close());
  const otherCoordinator = new SearchCoordinator({ ...f.service, store: second }, { clock: () => Date.parse('2026-10-07T08:00:00Z') });
  const [a,b] = await Promise.all([f.coordinator.claim({ ...main, workerId:'search-1' }, owner), otherCoordinator.claim({ ...main, workerId:'search-2' }, owner)]);
  assert.notEqual(a.lease.sourceId,b.lease.sourceId);
  assert.equal(f.coordinator.status(owner).session.sources.filter(i=>i.lease).length,2);
});

test('profile/main isolation, lease fencing, heartbeat and safe stop', async t => {
  const f = await fixture(t); await f.coordinator.start(start, owner);
  assert.equal(f.coordinator.status(other).session,null);
  await assert.rejects(f.coordinator.claim({ ...main, workerId:'search-1' }, other), /not active/);
  await assert.rejects(f.coordinator.start({ ...start,sessionId:'other-main' }, owner), /previous main/);
  await assert.rejects(f.coordinator.start({ ...start,sources:['linkedin'] }, owner), /no LinkedIn/);
  await assert.rejects(f.coordinator.start({ ...start,sources:['alpha','alpha'] }, owner), /unique/);
  const a = (await f.coordinator.claim({ ...main,workerId:'search-1' }, owner)).lease;
  await assert.rejects(f.coordinator.progress(scope(a,'search-2'), owner), /expired or was released/);
  f.setTime('2026-10-07T08:10:00Z'); await f.coordinator.progress(scope(a,'search-1'), owner);
  f.setTime('2026-10-07T08:25:00Z');
  assert.equal((await f.coordinator.claim({ ...main,workerId:'search-1' }, owner)).lease.id,a.id);
  f.setTime('2026-10-07T08:31:00Z');
  await assert.rejects(f.coordinator.progress(scope(a,'search-1'), owner), /expired/);
  const fresh = (await f.coordinator.claim({ ...main,workerId:'search-2' }, owner)).lease;
  assert.equal(fresh.sourceId,'alpha'); assert.notEqual(fresh.id,a.id);
  await f.coordinator.stop(main,owner);
  await assert.rejects(f.coordinator.progress(scope(fresh,'search-2'), owner), /not active/);
  assert.equal(f.coordinator.status(owner).session.active,false);
});

test('both sources enqueue the same official role once while the application remains paused', async t => {
  const f = await fixture(t); await f.coordinator.start(start, owner);
  const current = (await f.service.chromeQueue.add({ url:'https://employer.example/current' },owner)).application;
  await f.service.chromeQueue.claim(main,owner);
  await f.service.chromeQueue.checkpoint(current.id,{ ...main,kind:'captcha',message:'Owner CAPTCHA required',checkpoint:{ fields:[] } },owner);
  const leases = await Promise.all(['search-1','search-2'].map(workerId=>f.coordinator.claim({ ...main,workerId },owner)));
  const candidate = { title:'Engineer',company:'Fixture Employer',description:'Remote Python software role.',applyUrl:'https://employer.example/new',remote:true,mode:'full_time' };
  const results = await Promise.all(leases.map(({lease},i)=>f.coordinator.enqueue({ ...scope(lease,`search-${i+1}`),
    officialPostingReviewed:true,candidate:{ ...candidate,source:lease.sourceId },fit:{ decision:'relevant',reason:'Matches verified core experience' } },owner,f.discovery)));
  assert.equal(new Set(results.map(i=>i.applicationId)).size,1);
  assert.equal(f.service.chromeQueue.list(owner.profileId).pending,1);
  assert.equal(f.service.chromeQueue.list(owner.profileId).current.id,current.id);
  assert.equal(f.service.chromeQueue.list(owner.profileId).current.status,'waiting_owner');
  assert.equal(f.store.snapshot().attempts.length,0);
  await assert.rejects(f.coordinator.enqueue({ ...scope(leases[0].lease,'search-1'),officialPostingReviewed:true,candidate:{ ...candidate,source:'gamma' },fit:{ decision:'relevant' } },owner,f.discovery), /bind/);
});

test('revoked lease during role verification cannot enqueue or claim an application', async t => {
  const f = await fixture(t); await f.coordinator.start(start,owner);
  const lease = (await f.coordinator.claim({ ...main,workerId:'search-1' },owner)).lease;
  const discovery = { considerCandidate:async input => { const considered = await f.discovery.considerCandidate(input); await f.coordinator.stop(main,owner); return considered; } };
  await assert.rejects(f.coordinator.enqueue({ ...scope(lease,'search-1'),officialPostingReviewed:true,
    candidate:{ source:'alpha',title:'Engineer',company:'Fixture',description:'Full remote role',applyUrl:'https://employer.example/new' },
    fit:{ decision:'relevant',reason:'Verified fit' } },owner,discovery), /not active/);
  assert.equal(f.store.snapshot().applications.length,0);
});

test('scan and query are fenced to the assigned source/mode and never enable application execution', async t => {
  const f = await fixture(t); await f.coordinator.start(start,owner);
  const lease = (await f.coordinator.claim({ ...main,workerId:'search-1' },owner)).lease;
  const discovery = { scan: async input => { assert.deepEqual(input.sources,['alpha']); assert.equal(input.mode,'full_time'); assert.equal(input.reviewOnly,true); return { candidates:[] }; },
    query:async input => { assert.equal(input.source,'alpha'); assert.equal(input.reviewOnly,true); return { candidates:[] }; } };
  await f.coordinator.scan({ ...scope(lease,'search-1'),scan:{ sources:['beta'],mode:'freelance',reviewOnly:false } },owner,discovery);
  await f.coordinator.scan({ ...scope(lease,'search-1'),query:{ source:'beta',reviewOnly:false } },owner,discovery,true);
});

test('authenticated HTTP search routes work during a form hold; another applicant sees no state', async t => {
  const f = await fixture(t);
  const server = createHttpServer({ service:f.service,discovery:f.discovery,profiles:{},config:f.config,
    authenticate:req=>req.headers.authorization==='Bearer fixture' ? owner : req.headers.authorization==='Bearer other' ? other : null });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (action,body) => fetch(`${url}/v1/discovery/search/${action}`,{ method:'POST',headers:{ authorization:'Bearer fixture','content-type':'application/json' },body:JSON.stringify(body) });
  const active = (await f.service.chromeQueue.add({url:'https://employer.example/current'},owner)).application;
  await f.service.chromeQueue.claim(main,owner);
  await f.service.chromeQueue.checkpoint(active.id,{...main,kind:'missing_fact',message:'Fixture fact',checkpoint:{}},owner);
  f.discovery.scan = async input => { assert.deepEqual(input.sources,['alpha']); assert.equal(input.reviewOnly,true); return {candidates:[]}; };
  assert.equal((await post('start',start)).status,200);
  const a = await (await post('claim',{ ...main,workerId:'search-1' })).json(); assert.equal(a.lease.sourceId,'alpha');
  assert.equal((await post('scan',{...scope(a.lease,'search-1'),scan:{reviewOnly:false}})).status,200);
  assert.equal(f.service.chromeQueue.list(owner.profileId).current.status,'waiting_owner');
  assert.equal((await fetch(`${url}/v1/discovery/scan`,{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:'{}'})).status,409);
  assert.equal((await fetch(`${url}/v1/discovery/search`)).status,401);
  assert.equal((await (await fetch(`${url}/v1/discovery/search`,{ headers:{authorization:'Bearer other'} })).json()).session,null);
  assert.equal((await post('progress',{ ...scope(a.lease,'search-1'),pageComplete:true,reviewed:2 })).status,200);
  assert.equal((await post('stop',main)).status,200);
  assert.equal((await post('claim',{ ...main,workerId:'search-1' })).status,409);
});
