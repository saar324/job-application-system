import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStore } from '../src/store.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { ApplicationService } from '../src/service.js';
import { createHttpServer } from '../src/http.js';
import { ownerSubmissionSentAt } from '../dashboard/owner-submission.mjs';

const owner = { actorId: 'application-session', profileId: 'applicant' };
const other = { actorId: 'other-session', profileId: 'other-applicant' };
const input = { sessionId: 'chat-one' };
const preview = () => ({ company: 'Example', title: 'Engineer', destination: 'https://employer.example/apply',
  officialPostingReviewed: true, resumeUploaded: true, fit: { decision: 'relevant', reason: 'Matches verified core experience' },
  filled: [{ key: 'name', label: 'Name', value: 'Example Applicant', required: true, source: 'saved profile' }], unfilled: [] });
const evidence = () => ({ manuallyVerified: true, finalUrl: 'https://employer.example/thanks',
  successText: 'We received your application', observedAt: new Date().toISOString(), visualReceiptHash: 'a'.repeat(64) });
async function fixture(t, kind = 'sqlite', cap = 8, receiptFetchImpl) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chrome-queue-'));
  const file = path.join(dir, kind === 'sqlite' ? 'state.sqlite' : 'state.json');
  const store = await (kind === 'sqlite' ? new SqliteStore(file) : new JsonStore(file)).init();
  let browserCalls = 0;
  const profile = { contact: { email: 'applicant@example.test' }, documents: { resume: '/approved/resume.pdf' }, applicationAnswers: {} };
  const config = { defaultMode: 'full_time', execution: { workflow: 'chrome_session', maxApplicationsPerDay: cap },
    modes: { full_time: { minimumScore: 75, dailyApplicationCap: cap }, freelance: { minimumScore: 70, dailyApplicationCap: cap } } };
  const service = new ApplicationService({ store, config, adapter: { name: 'must-not-run', submit: () => { browserCalls++; } },
    profiles: { get: async () => structuredClone(profile) }, receiptFetchImpl });
  t.after(async () => { store.close?.(); await rm(dir, { recursive: true, force: true }); });
  return { service, queue: service.chromeQueue, store, file, profile, config, browserCalls: () => browserCalls };
}
async function add(queue, n, identity = owner) { return queue.add({ url: `https://employer.example/jobs/${n}` }, identity); }
async function review(queue, id, extra = {}) { return queue.review(id, { ...input, authorizationSource: 'Owner delegated routine final review and submission', preview: preview(), ...extra }, owner); }
async function submit(queue, id) {
  const r = await review(queue, id);
  const a = await queue.startSubmission(id, { ...input, previewFingerprint: r.previewFingerprint }, owner);
  return { review: r, attempt: a };
}

for (const kind of ['json', 'sqlite']) test(`${kind}: durable FIFO, duplicate links, stop and wait, then sequential receipt`, async t => {
  const f = await fixture(t, kind);
  const first = (await add(f.queue, 1)).application;
  const second = (await add(f.queue, 2)).application;
  assert.equal((await add(f.queue, 1)).application.id, first.id);
  assert.equal(f.queue.list(owner.profileId).pending, 2);
   assert.equal(f.browserCalls(), 0);
  assert.equal((await f.queue.claim(input, owner)).application.id, first.id);
  await f.queue.checkpoint(first.id, { ...input, kind: 'captcha', message: 'Owner must complete CAPTCHA', checkpoint: { fields: [{ key: 'name', value: 'Example Applicant' }] } }, owner);
  const third = (await add(f.queue, 3)).application;
  assert.equal((await f.queue.claim(input, owner)).application.id, first.id);
  assert.equal((await f.queue.claim(input, owner)).waiting, true);
  const reopened = await (kind === 'sqlite' ? new SqliteStore(f.file) : new JsonStore(f.file)).init();
  assert.equal(reopened.snapshot().applications.find(i => i.id === first.id).status, 'waiting_owner'); reopened.close?.();
  await assert.rejects(f.queue.resume(first.id, input, owner), /owner resolution/);
  await f.queue.resume(first.id, { ...input, resolution: 'Owner completed the visible challenge' }, owner);
  const { attempt } = await submit(f.queue, first.id);
  await f.queue.receipt(first.id, { ...input, attemptId: attempt.attemptId, receipt: evidence() }, owner);
  assert.equal((await f.queue.claim(input, owner)).application.id, second.id);
  assert.equal(f.queue.list(owner.profileId).submitted, 1);
  assert.equal(f.queue.list(owner.profileId).items[2].id, third.id);
  assert.equal(f.browserCalls(), 0);
});

test('profile isolation, session ownership and concurrent enqueue claims', async t => {
  const { queue } = await fixture(t);
  const links = await Promise.all(Array.from({ length: 5 }, () => add(queue, 1)));
  assert.equal(new Set(links.map(i => i.application.id)).size, 1);
  const id = links[0].application.id;
  await add(queue, 99, other);
  assert.equal(queue.list(owner.profileId).items.length, 1);
  assert.equal(queue.list(other.profileId).items.length, 1);
  const [a,b] = await Promise.all([queue.claim(input, owner), queue.claim(input, owner)]);
  assert.equal(a.application.id, b.application.id);
  await assert.rejects(queue.claim({ sessionId: 'chat-two' }, owner), /another session/);
  await assert.rejects(queue.checkpoint(id, { ...input, kind: 'fact', message: 'Question' }, other), /not found/);
  await assert.rejects(queue.checkpoint(id, { sessionId: 'chat-two', kind: 'fact', message: 'Question' }, owner), /does not own/);
});

test('exact review, required fields, current CV and profile changes gate the final action', async t => {
  const { queue, profile } = await fixture(t);
  const id = (await add(queue, 1)).application.id; await queue.claim(input, owner);
  const blank = preview(); blank.unfilled.push({ key: 'required', label: 'Required question', required: true });
  await assert.rejects(review(queue, id, { preview: blank }), /complete live review/);
  const noCv = preview(); noCv.resumeUploaded = false;
  await assert.rejects(review(queue, id, { preview: noCv }), /current CV/);
  const r = await review(queue, id);
  await assert.rejects(queue.startSubmission(id, { ...input, previewFingerprint: 'b'.repeat(64) }, owner), /current review/);
  profile.contact.email = 'changed@example.test';
  await assert.rejects(queue.startSubmission(id, { ...input, previewFingerprint: r.previewFingerprint }, owner), /facts or preview changed/);
  await submit(queue, id);
  await assert.rejects(queue.startSubmission(id, { ...input, previewFingerprint: r.previewFingerprint }, owner), /already started/);
});

test('uncertain Submit freezes queue across restart and cannot resume or retry', async t => {
  const { queue, service } = await fixture(t);
  const id = (await add(queue, 1)).application.id; await add(queue, 2); await queue.claim(input, owner);
  const { attempt } = await submit(queue, id);
  await queue.checkpoint(id, { ...input, kind: 'outcome_check', message: 'Connection lost after click', checkpoint: { finalUrl: 'https://employer.example/apply' } }, owner);
  await service.recover();
  assert.equal((await queue.claim(input, owner)).application.id, id);
  await assert.rejects(queue.resume(id, { ...input, resolution: 'Try again' }, owner), /do not repeat Submit/);
  await assert.rejects(queue.validationError(id, { ...input, attemptId: attempt.attemptId, employerExplicitlyRejected: true, errors: ['Required name'] }, owner), /explicit live employer/);
  await assert.rejects(queue.skip(id, { ...input, reason: 'Give up' }, owner), /explicit owner decision/);
  await queue.receipt(id, { ...input, attemptId: attempt.attemptId, receipt: evidence() }, owner);
  assert.equal(queue.list(owner.profileId).submitted, 1);
});

test('receipt requires proof for the exact recorded employer attempt', async t => {
  const { queue } = await fixture(t); const id = (await add(queue, 1)).application.id; await queue.claim(input, owner);
  await assert.rejects(queue.receipt(id, { ...input, attemptId: 'no-attempt', receipt: evidence() }, owner), /does not match/);
  const { attempt } = await submit(queue, id);
  await assert.rejects(queue.receipt(id, { ...input, attemptId: attempt.attemptId, receipt: { ...evidence(), simulated: true } }, owner), /verified employer/);
  await assert.rejects(queue.receipt(id, { ...input, attemptId: attempt.attemptId, receipt: { ...evidence(), finalUrl: 'https://unrelated.example/thanks' } }, owner), /verified official ATS employer link/);
  await assert.rejects(queue.receipt(id, { ...input, attemptId: attempt.attemptId, receipt: { ...evidence(), successText: '' } }, owner), /success text/);
  assert.equal(queue.list(owner.profileId).submitted, 0);
});

const redirectSource = 'https://jobs.lever.co/example/11111111-1111-4111-8111-111111111111/apply';
const redirectFinal = 'https://www.employer.example/thanks?application=fixture-receipt';
const redirectEvidence = () => ({sourceUrl:redirectSource, employerUrl:'https://www.employer.example/', linkText:'Example Home Page'});
const employerPage = '<html><a href="http://www.employer.example">Example Home Page</a></html>';
async function startRedirect(queue) {
 const id = (await queue.add({url:redirectSource, company:'Example', title:'Engineer'}, owner)).application.id;
 await queue.claim(input, owner);
 const p = preview(); p.destination = redirectSource;
 const r = await review(queue, id, {preview:p});
 const attempt = await queue.startSubmission(id, {...input, previewFingerprint:r.previewFingerprint}, owner);
 return {id, attempt};
}

for (const kind of ['json', 'sqlite']) test(`${kind}: verified ATS employer redirect completes held attempt once and advances FIFO`, async t => {
 const requests = [];
 const f = await fixture(t, kind, 8, async (url, options) => {
  requests.push({url, options}); return new Response(employerPage, {headers:{'content-type':'text/html'}});
 });
 const {id, attempt} = await startRedirect(f.queue);
 const next = (await add(f.queue, 2)).application.id;
 await f.queue.checkpoint(id, {...input, kind:'captcha', message:'Owner completes verification'}, owner);
 const body = {...input, attemptId:attempt.attemptId, redirectEvidence:redirectEvidence(),
  receipt:{...evidence(), finalUrl:redirectFinal, successText:'Thank you for submitting your application'}};
 const result = await f.queue.receipt(id, body, owner);
 assert.equal(result.status, 'submitted');
 assert.equal(result.receipt.finalUrl, redirectFinal);
 assert.equal(result.receipt.destinationVerification.sourceUrl, redirectSource);
 assert.match(result.receipt.destinationVerification.sourceContentHash, /^[a-f0-9]{64}$/);
 assert.equal(requests[0].url, redirectSource);
 assert.equal(requests[0].options.redirect, 'error');
 assert.equal(requests[0].options.headers.authorization, undefined);
 assert.equal((await f.queue.receipt(id, body, owner)).duplicate, true);
 assert.equal(requests.length, 1);
 assert.equal(f.queue.list(owner.profileId).submitted, 1);
 assert.equal(f.store.snapshot().attempts.length, 1);
 assert.equal((await f.queue.claim(input, owner)).application.id, next);
 await assert.rejects(f.queue.receipt(id, {...body, receipt:{...body.receipt, finalUrl:'https://unrelated.example/thanks'}}, owner), /different evidence/);
});

test('redirect evidence cannot bypass attempt, session, source role or unrelated destination checks', async t => {
 let calls = 0;
 const {queue} = await fixture(t, 'sqlite', 8, async () => {calls++; return new Response(employerPage,{headers:{'content-type':'text/html'}})});
 const {id, attempt} = await startRedirect(queue);
 const body = {...input, attemptId:attempt.attemptId, redirectEvidence:redirectEvidence(),receipt:{...evidence(),finalUrl:redirectFinal}};
 await assert.rejects(queue.receipt(id, {...body,attemptId:'other-attempt'}, owner), /recorded final attempt/);
 await assert.rejects(queue.receipt(id, {...body,sessionId:'other-chat'}, owner), /session does not own/);
 await assert.rejects(queue.receipt(id, body, other), /not found/);
 await assert.rejects(queue.receipt(id, {...body,redirectEvidence:{...redirectEvidence(),sourceUrl:redirectSource.replace('111111111111','222222222222')}}, owner), /official ATS employer link/);
 await assert.rejects(queue.receipt(id, {...body,receipt:{...body.receipt,finalUrl:'https://unrelated.example/thanks'}}, owner), /employer origin/);
 await assert.rejects(queue.receipt(id, {...body,redirectEvidence:undefined,receipt:{...body.receipt,destinationVerification:{kind:'official_ats_employer_link'}}}, owner), /official ATS employer link/);
 assert.equal(calls, 0);
 await assert.rejects(queue.receipt(id, {...body,redirectEvidence:{...redirectEvidence(),employerUrl:'https://unrelated.example/'},receipt:{...body.receipt,finalUrl:'https://unrelated.example/thanks'}}, owner), /not the official ATS company link/);
 assert.equal(calls, 1);
 assert.equal(queue.list(owner.profileId).submitted, 0);
});

test('owner redirect receipt uses the same verification, counts in the collector and stays idempotent', async t => {
 let calls = 0;
 const {queue,store} = await fixture(t, 'sqlite', 8, async () => {calls++;return new Response(employerPage,{headers:{'content-type':'text/html'}})});
 const id = (await queue.add({url:redirectSource,company:'Example',title:'Engineer'},owner)).application.id;
 await queue.claim(input,owner);
 await queue.checkpoint(id,{...input,kind:'captcha',message:'Owner completed the form'},owner);
 const observedAt = new Date().toISOString();
 const body = {...input,ownerSubmitted:true,recordKey:'fixture-redirect',observedAt,
  submissionDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(observedAt)),
  finalUrl:redirectFinal,redirectEvidence:redirectEvidence(),evidence:{source:'owner_provided_employer_confirmation',successText:'Thank you for submitting your application',reference:'Owner exact current role confirmation',sha256:'b'.repeat(64)}};
 assert.equal((await queue.ownerReceipt(id,body,owner)).duplicate,false);
 const app=store.snapshot().applications.find(i=>i.id===id);
 assert.ok(ownerSubmissionSentAt(app));
 assert.equal(ownerSubmissionSentAt({...app,ownerSubmission:{...app.ownerSubmission,destinationVerification:undefined}}),null);
 assert.equal((await queue.ownerReceipt(id,body,owner)).duplicate,true);
 assert.equal(calls,1);
 assert.equal(queue.list(owner.profileId).submitted,1);
 assert.equal(store.snapshot().attempts.length,0);
});

test('safe checkpoints and reviews reject password and verification-code fields', async t => {
  const { queue } = await fixture(t); const id = (await add(queue, 1)).application.id; await queue.claim(input, owner);
  await assert.rejects(queue.checkpoint(id, { ...input, kind: 'fact', message: 'Question', checkpoint: { fields: [{ label: 'Verification code', value: 'do-not-log' }] } }, owner), /must not enter/);
  const p = preview(); p.filled.push({ key: 'password', label: 'Password', value: 'do-not-log', source: 'browser' });
  await assert.rejects(review(queue, id, { preview: p }), /must not enter/);
});

test('scoped saved recruitment consent passes, unrelated consent and Terms do not', async t => {
  const { queue, profile } = await fixture(t); const id = (await add(queue, 1)).application.id; await queue.claim(input, owner);
  const p = preview(); p.filled.push({ key: 'privacy', label: 'Recruitment privacy policy', value: true, source: 'saved consent', required: true });
  await assert.rejects(review(queue, id, { preview: p }), /legal field/);
  profile.applicationAnswers.job_application_required_privacy_policy_approved = true;
  const fieldEvidence = [{ key: 'privacy', sourceKind: 'saved_recruitment_consent', profileAnswerKey: 'job_application_required_privacy_policy_approved', sourceReference: 'Owner authorized mandatory recruitment privacy' }];
  await review(queue, id, { preview: p, fieldEvidence });
  p.filled[1].label = 'Agree to privacy policy and Terms of Service';
  await assert.rejects(review(queue, id, { preview: p, fieldEvidence }), /legal field/);
});

test('an exact owner answer resolves a new legal question only on the current waiting application', async t => {
  const { queue } = await fixture(t);
  const id = (await add(queue, 1)).application.id; await add(queue, 2); await queue.claim(input, owner);
  const field = { key: 'terms', label: 'I accept the employer application Terms', value: true, required: true, source: 'current owner answer' };
  const p = preview(); p.filled.push(field);
  const fieldEvidence = [{ key: 'terms', sourceKind: 'current_owner_answer', resolutionIndex: 0, sourceReference: 'Owner explicitly accepted this exact question in the current chat' }];
  await assert.rejects(review(queue, id, { preview: p, fieldEvidence }), /legal field/);
  await queue.checkpoint(id, { ...input, kind: 'legal_question', message: field.label }, owner);
  await queue.resume(id, { ...input, resolution: 'Owner accepted the exact application Terms', ownerAnswers: [{ ...field, sourceReference: fieldEvidence[0].sourceReference }] }, owner);
  await queue.checkpoint(id, { ...input, kind: 'captcha', message: 'Complete the visible CAPTCHA' }, owner);
  await queue.resume(id, { ...input, resolution: 'Owner completed CAPTCHA' }, owner);
  const r = await review(queue, id, { preview: p, fieldEvidence });
  const changed = structuredClone(p); changed.filled[1].label += ' and a liability waiver';
  await assert.rejects(review(queue, id, { preview: changed, fieldEvidence }), /scope/);
  const attempt = await queue.startSubmission(id, { ...input, previewFingerprint: r.previewFingerprint }, owner);
  await queue.receipt(id, { ...input, attemptId: attempt.attemptId, receipt: evidence() }, owner);
  const next = (await queue.claim(input, owner)).application;
  await assert.rejects(review(queue, next.id, { preview: p, fieldEvidence }), /legal field/);
});

test('credit-check authorization cannot bypass scoped review through its wording', async t => {
  const { queue } = await fixture(t);
  const id = (await add(queue, 1)).application.id; await queue.claim(input, owner);
  const p = preview(); p.filled.push({ key: 'credit_check', label: 'I authorize a credit check', value: true, required: true, source: 'previous application' });
  await assert.rejects(review(queue, id, { preview: p }), /legal field/);
});

test('pending queue entries do not consume capacity; actual final actions do', async t => {
  const { queue } = await fixture(t, 'sqlite', 1);
  const id = (await add(queue, 1)).application.id; await add(queue, 2); await add(queue, 3); await queue.claim(input, owner);
  const { attempt } = await submit(queue, id); await queue.receipt(id, { ...input, attemptId: attempt.attemptId, receipt: evidence() }, owner);
  const next = (await queue.claim(input, owner)).application;
  const r = await review(queue, next.id);
  await assert.rejects(queue.startSubmission(next.id, { ...input, previewFingerprint: r.previewFingerprint }, owner), /daily submission cap/);
  assert.equal(queue.list(owner.profileId).pending, 1);
});

test('explicit employer field errors allow bounded correction with a fresh review', async t => {
  const { queue } = await fixture(t); const id = (await add(queue, 1)).application.id; await queue.claim(input, owner);
  for (let n=0;n<3;n++) {
    const { attempt } = await submit(queue, id);
    const correction = { ...input, attemptId: attempt.attemptId, employerExplicitlyRejected: true, errors: ['Required field: Name'] };
    if (n<2) await queue.validationError(id, correction, owner);
    else await assert.rejects(queue.validationError(id, correction, owner), /retry limit/);
  }
  assert.equal(queue.list(owner.profileId).current.status, 'submission_started');
});

test('legacy uncertain submissions are adopted without replay; historical receipts remain intact', async t => {
  const { queue, service, store } = await fixture(t);
  const opportunity = await service.addOpportunity({ title: 'Engineer', company: 'Example', applyUrl: 'https://employer.example/jobs/1' }, owner);
  await store.mutate(state => state.applications.push({ id: 'legacy', opportunityId: opportunity.id, profileId: owner.profileId,
    mode: 'full_time', status: 'waiting_confirmation', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pause: { phase: 'final_action_started' } }));
  const adopted = await add(queue, 1); assert.equal(adopted.application.id, 'legacy');
  const current = await queue.claim(input, owner); assert.equal(current.application.status, 'submission_unverified');
  await assert.rejects(queue.resume('legacy', { ...input, resolution: 'Try again' }, owner), /do not repeat/);
  await queue.skip('legacy', { ...input, reason: 'Owner explicitly stopped pursuit after outcome review', ownerStoppedPursuit: true }, owner);
  assert.equal(store.snapshot().applications[0].submissionOutcome, 'unverified');
});

test('HTTP workflow is passive, isolated and blocks retired final-action APIs', async t => {
  const f = await fixture(t);
  const server = createHttpServer({ service: f.service, profiles: f.service.profiles, config: f.config,
    authenticate: request => request.headers.authorization === 'Bearer profile-one' ? owner : request.headers.authorization === 'Bearer profile-two' ? other : null,
    discovery: { scan: async input => input } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (pathname, body, token = 'profile-one') => fetch(base+pathname, { method: body ? 'POST':'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type':'application/json' }, ...(body ? { body:JSON.stringify(body) } : {}) });
  const direct = await (await call('/v1/direct-applications', { url:'https://employer.example/apply', profileId:other.profileId })).json();
  assert.equal(direct.application.status, 'pending'); assert.equal(direct.application.profileId, owner.profileId);
  assert.equal((await (await call('/v1/chrome-queue', null, 'profile-two')).json()).pending, 0);
  assert.equal((await call('/v1/campaigns', { target:100 })).status, 410);
  assert.equal((await call('/v1/confirmations/approve-batch', { entries:[] })).status, 410);
  assert.equal((await call('/v1/internal/final-commit', {})).status, 410);
  assert.equal((await (await call('/v1/discovery/scan', { reviewOnly:false })).json()).reviewOnly, true);
  const state = await (await call('/v1/chrome-queue')).json(); assert.equal(state.pending, 1);
  assert.equal(f.browserCalls(), 0);
});

test('review rejects duplicate fields and stale role or review evidence', async t => {
 const {queue,store}=await fixture(t);const id=(await add(queue,1)).application.id;await queue.claim(input,owner);
 const p=preview();p.filled.push({...p.filled[0]});await assert.rejects(review(queue,id,{preview:p}),/duplicate/);
 let r=await review(queue,id);
 await store.mutate(s=>s.opportunities[0].title='Changed posting');
 await assert.rejects(queue.startSubmission(id,{...input,previewFingerprint:r.previewFingerprint},owner),/changed/);
 r=await review(queue,id);
 await store.mutate(s=>s.applications[0].review.at=new Date(Date.now()-11*60_000).toISOString());
 await assert.rejects(queue.startSubmission(id,{...input,previewFingerprint:r.previewFingerprint},owner),/review/);
});

test('explicit owner session recovery preserves a blocker and prevents uncertain resubmission',async t=>{
 const {queue}=await fixture(t);const id=(await add(queue,1)).application.id;await queue.claim(input,owner);
 await queue.checkpoint(id,{...input,kind:'fact',message:'Unknown current fact'},owner);
 await queue.takeover(id,{sessionId:'new-chat',ownerRecoveryReference:'Owner requested recovery in this chat'},owner);
 await assert.rejects(queue.resume(id,{...input,resolution:'Owner supplied answer'},owner),/does not own/);
 await queue.resume(id,{sessionId:'new-chat',resolution:'Owner supplied answer'},owner);
 const r=await queue.review(id,{sessionId:'new-chat',preview:preview(),authorizationSource:'Owner requested routine application'},owner);
 await queue.startSubmission(id,{sessionId:'new-chat',previewFingerprint:r.previewFingerprint},owner);
 await queue.takeover(id,{sessionId:'third-chat',ownerRecoveryReference:'Owner asked to inspect unknown outcome'},owner);
 assert.equal(queue.list(owner.profileId).current.status,'submission_unverified');
 await assert.rejects(queue.resume(id,{sessionId:'third-chat',resolution:'Repeat'},owner),/do not repeat/);
});

test('current queue answers and blockers appear in existing logs; prior employer metadata stays',async t=>{
 const {queue,service}=await fixture(t);const id=(await add(queue,1)).application.id;await queue.claim(input,owner);
 await queue.checkpoint(id,{...input,kind:'fact',message:'Owner answer needed',checkpoint:{fields:[{key:'name',label:'Name',value:'Example Applicant',status:'filled'}]}},owner);
 assert.equal(service.applicationLog(owner.profileId)[0].blocker.kind,'fact');
 assert.equal(service.applicationLog(owner.profileId)[0].pausedFields.length,1);
 await queue.resume(id,{...input,resolution:'Owner supplied fact'},owner);const {attempt}=await submit(queue,id);
 await queue.receipt(id,{...input,attemptId:attempt.attemptId,receipt:evidence()},owner);
 const log=service.applicationLog(owner.profileId)[0];assert.equal(log.submittedFields[0].value,'Example Applicant');assert.equal(log.questionsAndAnswers[0].answer,'Example Applicant');
 await service.recordEmployerStatus(id,{status:'under_review',observedAt:new Date().toISOString(),sourceId:'synthetic-message'},owner);
 assert.equal(service.applicationLog(owner.profileId)[0].employerStatus.status,'under_review');
});

function ownerProof(n = 1) {
  const observedAt = new Date().toISOString();
  return { ...input, ownerSubmitted: true, recordKey: `owner-confirmation-${n}`,
    finalUrl: `https://employer.example/jobs/${n}/confirmation`, observedAt,
    submissionDate: new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(observedAt)),
    evidence: { source: 'owner_provided_employer_confirmation', successText: 'Thank you for applying. Your application has been received.',
      reference: 'Owner pasted exact employer confirmation in this chat', sha256: 'a'.repeat(64) } };
}

for (const kind of ['json', 'sqlite']) test(`${kind}: owner receipt completes held form without a retrospective attempt and counts once`, async t => {
  const {queue,store,file,service} = await fixture(t, kind);
  const id=(await add(queue,1)).application.id;
  const next=(await add(queue,2)).application.id;
  await queue.claim(input,owner);
  await queue.checkpoint(id,{...input,kind:'tool_permission',message:'Privacy confirmation pending',checkpoint:{fields:[{key:'name',label:'Name',value:'Example Applicant'}]}},owner);
  const proof=ownerProof();
  assert.equal((await queue.ownerReceipt(id,proof,owner)).duplicate,false);
  assert.equal((await queue.ownerReceipt(id,{...proof,observedAt:new Date().toISOString()},owner)).duplicate,true);
  const app=store.snapshot().applications.find(a=>a.id===id);
  assert.equal(app.status,'owner_reported_submitted');
  assert.equal(app.ownerSubmission.channel,'browser');
  assert.equal(app.blocker,undefined);
  assert.equal(app.finalAction,undefined);
  assert.equal(app.receipt,undefined);
  assert.equal(app.checkpoint.fields.length,1);
  assert.equal(store.snapshot().attempts.length,0);
  assert.equal(queue.list(owner.profileId).submitted,1);
  assert.ok(service.applicationLog(owner.profileId).find(a=>a.applicationId===id).submittedAt);
  await service.recover();
  assert.equal((await queue.claim(input,owner)).application.id,next);
  const reopened=await (kind==='sqlite'?new SqliteStore(file):new JsonStore(file)).init();
  assert.equal(reopened.snapshot().applications.find(a=>a.id===id).ownerSubmission.recordKey,proof.recordKey);
  reopened.close?.();
  await assert.rejects(queue.ownerReceipt(id,{...proof,evidence:{...proof.evidence,sha256:'b'.repeat(64)}},owner),/different evidence/);
  await assert.rejects(queue.resume(id,{...input,resolution:'Try again'},owner),/already terminal/);
  await assert.rejects(queue.startSubmission(id,{...input},owner),/already terminal/);
});

for (const kind of ['json', 'sqlite']) test(`${kind}: YC named-employer receipt counts once and releases the queue without an attempt`, async t => {
  const { queue, store } = await fixture(t, kind);
  const url = 'https://www.ycombinator.com/companies/example-ai/jobs/ExampleId-full-stack-engineer';
  const id = (await queue.add({ url }, owner)).application.id;
  const next = (await add(queue, 2)).application.id;
  await queue.claim(input, owner);
  await queue.checkpoint(id, { ...input, kind: 'receipt_logging_bug', message: 'Exact employer receipt awaits import' }, owner);
  const proof = { ...ownerProof(), finalUrl: url, evidence: { ...ownerProof().evidence,
    successText: 'Thank you for applying. Your application to Example.ai has been received.' } };
  assert.equal((await queue.ownerReceipt(id, proof, owner)).duplicate, false);
  assert.equal((await queue.ownerReceipt(id, proof, owner)).duplicate, true);
  const application = store.snapshot().applications.find(a => a.id === id);
  assert.ok(ownerSubmissionSentAt(application));
  assert.equal(application.ownerSubmission.evidence.successText, proof.evidence.successText);
  assert.equal(application.finalAction, undefined);
  assert.equal(store.snapshot().attempts.length, 0);
  assert.equal(queue.list(owner.profileId).submitted, 1);
  assert.equal((await queue.claim(input, owner)).application.id, next);
});

test('owner receipt rejects wrong role, identity, session, incomplete or failed confirmations and invalid dates',async t=>{
 const {queue}=await fixture(t);const id=(await add(queue,1)).application.id;await queue.claim(input,owner);
 const p=ownerProof();
 await assert.rejects(queue.ownerReceipt(id,p,other),/not found/);
 await assert.rejects(queue.ownerReceipt(id,{...p,sessionId:'another'},owner),/does not own/);
 for(const finalUrl of ['https://unrelated.example/jobs/1/confirmation','https://employer.example/jobs/2/confirmation'])
  await assert.rejects(queue.ownerReceipt(id,{...p,finalUrl},owner),/exact official role/);
 for(const successText of ['Review your application','Thank you for applying','Application not submitted','Your application has been received. Error occurred.'])
  await assert.rejects(queue.ownerReceipt(id,{...p,evidence:{...p.evidence,successText}},owner),/explicit owner submission/);
 await assert.rejects(queue.ownerReceipt(id,{...p,ownerSubmitted:false},owner),/explicit owner submission/);
 await assert.rejects(queue.ownerReceipt(id,{...p,evidence:{...p.evidence,simulated:true}},owner),/explicit owner submission/);
 await assert.rejects(queue.ownerReceipt(id,{...p,submissionDate:'2099-01-01'},owner),/submission date/);
 await assert.rejects(queue.ownerReceipt(id,{...p,observedAt:'2099-01-01T12:00:00Z'},owner),/observation time/);
 assert.equal(queue.list(owner.profileId).submitted,0);
});

test('owner receipt accepts Greenhouse role confirmation and cannot replace an uncertain agent attempt',async t=>{
 const {queue,store}=await fixture(t);
 const app=(await queue.add({url:'https://job-boards.greenhouse.io/example/jobs/123'},owner)).application;
 await queue.claim(input,owner);
 await queue.ownerReceipt(app.id,{...ownerProof(),finalUrl:'https://job-boards.greenhouse.io/example/jobs/123/confirmation'},owner);
 const next=(await add(queue,2)).application.id;await queue.claim(input,owner);await submit(queue,next);
 await assert.rejects(queue.ownerReceipt(next,ownerProof(2),owner),/existing final attempt/);
 assert.equal(store.snapshot().attempts.length,1);
 assert.equal(queue.list(owner.profileId).current.id,next);
});

test('owner receipt consumes daily capacity without manufacturing an attempt',async t=>{
 const {queue,store}=await fixture(t,'sqlite',1);const id=(await add(queue,1)).application.id;await add(queue,2);await queue.claim(input,owner);
 await queue.ownerReceipt(id,ownerProof(),owner);
 const next=(await queue.claim(input,owner)).application.id;const r=await review(queue,next);
 await assert.rejects(queue.startSubmission(next,{...input,previewFingerprint:r.previewFingerprint},owner),/daily submission cap/);
 assert.equal(store.snapshot().attempts.length,0);
});

test('authenticated HTTP owner receipt completes only the current applicant queue entry',async t=>{
 const f=await fixture(t);const id=(await add(f.queue,1)).application.id;await f.queue.claim(input,owner);
 const server=createHttpServer({service:f.service,profiles:f.service.profiles,config:f.config,authenticate:r=>r.headers.authorization==='Bearer profile-one'?owner:other,discovery:{}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/v1/chrome-queue/${id}/owner-receipt`;
 const call=token=>fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({...ownerProof(),profileId:other.profileId})});
 assert.equal((await call('profile-two')).status,404);
 const response=await call('profile-one');assert.equal(response.status,200);
 assert.equal((await response.json()).status,'owner_reported_submitted');assert.equal(f.queue.list(owner.profileId).submitted,1);
});
