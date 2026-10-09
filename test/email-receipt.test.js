import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStore } from '../src/store.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { ApplicationService } from '../src/service.js';
import { createHttpServer } from '../src/http.js';
import { verifyEmailReceipt } from '../src/email-receipt.js';

const identity = { actorId: 'main', profileId: 'applicant' }, scope = { sessionId: 'chat' };
async function fixture(t, kind = 'sqlite') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'email-receipt-'));
  const store = await (kind === 'json' ? new JsonStore(path.join(dir, 'state.json')) : new SqliteStore(path.join(dir, 'state.sqlite'))).init();
  let networkCalls = 0;
  const service = new ApplicationService({ store, config: {defaultMode:'full_time', modes:{full_time:{dailyApplicationCap:10}}},
    profiles: {get:async()=>({contact:{email:'applicant@example.test'}})},
    receiptFetchImpl:async()=>{networkCalls++; throw new Error('No mailbox or employer fetch allowed');} });
  const queue = service.chromeQueue, destination = 'https://www.example.com/jobs/engineer';
  const {application:{id}} = await queue.add({url:destination,company:'Example',title:'Engineer'},identity);
  await queue.add({url:'https://www.example.com/jobs/next',company:'Example',title:'Next role'},identity);
  await queue.claim(scope,identity);
  const review = await queue.review(id,{...scope,authorizationSource:'Synthetic owner delegation',preview:{company:'Example',title:'Engineer',destination,
    officialPostingReviewed:true,resumeUploaded:true,fit:{decision:'relevant',reason:'Synthetic match'},filled:[{key:'name',label:'Name',value:'Example Applicant',source:'Synthetic profile',required:true}],unfilled:[]}},identity);
  const attempt = await queue.startSubmission(id,{...scope,previewFingerprint:review.previewFingerprint},identity);
  await queue.checkpoint(id,{...scope,kind:'outcome_check',message:'Inspect employer receipt'},identity);
  const receivedAt = new Date().toISOString(), subject = 'Your application for Example - Engineer';
  await service.recordEmployerStatus(id,{status:'application_received',source:'verified_employer_email',sourceId:'proton:applicant:message-one',subject,observedAt:receivedAt},identity);
  const body = {...scope,attemptId:attempt.attemptId,receipt:{manuallyVerified:true,evidenceType:'employer_confirmation_email',
    finalUrl:'https://mail.proton.me/u/0/inbox/message-one',successText:'Your application to Example has been received.',observedAt:new Date().toISOString(),visualReceiptHash:'a'.repeat(64),
    emailEvidence:{messageReference:'proton:applicant:message-one',sender:'hiring@example.com',recipient:'applicant@example.test',company:'Example',title:'Engineer',subject,receivedAt}}};
  t.after(async()=>{store.close?.(); await rm(dir,{recursive:true,force:true});});
  return {service,queue,store,id,body,networkCalls:()=>networkCalls};
}

for (const kind of ['json','sqlite']) test(`${kind}: email receipt resolves original attempt once and releases FIFO`,async t=>{
  const f = await fixture(t,kind);
  const result = await f.queue.receipt(f.id,f.body,identity);
  assert.equal(result.status,'submitted');
  assert.equal(result.receipt.finalUrl,f.body.receipt.finalUrl);
  assert.equal(result.receipt.submittedAt,f.body.receipt.emailEvidence.receivedAt);
  assert.equal(result.receipt.emailVerification.kind,'verified_employer_email');
  assert.equal(result.blocker,undefined);
  assert.equal(f.store.snapshot().attempts.length,1);
  assert.equal(f.store.snapshot().attempts[0].status,'submitted');
  assert.equal((await f.queue.receipt(f.id,f.body,identity)).duplicate,true);
  assert.equal(f.queue.list(identity.profileId).submitted,1);
  assert.equal((await f.queue.claim(scope,identity)).application.opportunityId,f.store.snapshot().opportunities[1].id);
  assert.equal(f.networkCalls(),0);
  const changed=structuredClone(f.body);changed.receipt.emailEvidence.sender='other@example.com';
  await assert.rejects(f.queue.receipt(f.id,changed,identity),/different evidence/);
});

test('email proof rejects wrong applicant, session, attempt and mismatched or incomplete evidence',async t=>{
  const f=await fixture(t);
  for(const patch of [
    b=>b.sessionId='other-chat', b=>b.attemptId='other-attempt',
    b=>b.receipt.emailEvidence.recipient='other@example.test',
    b=>b.receipt.emailEvidence.sender='hiring@example.org',
    b=>b.receipt.emailEvidence.company='Other', b=>b.receipt.emailEvidence.title='Next role',
    b=>b.receipt.emailEvidence.subject='Your application for Example - Next role',
    b=>b.receipt.emailEvidence.messageReference='proton:applicant:other-message',
    b=>b.receipt.emailEvidence.receivedAt='2000-01-01T00:00:00Z',
    b=>b.receipt.emailEvidence.receivedAt='2100-01-01T00:00:00Z',
    b=>delete b.receipt.emailEvidence, b=>b.receipt.successText='Unable to submit your application',
    b=>b.receipt.finalUrl='https://unrelated.example/thanks',
    b=>{delete b.receipt.evidenceType;b.receipt.emailVerification={kind:'verified_employer_email'};}
  ]) {
    const body=structuredClone(f.body);patch(body);
    await assert.rejects(f.queue.receipt(f.id,body,identity));
    assert.equal(f.queue.list(identity.profileId).current.id,f.id);
    assert.equal(f.queue.list(identity.profileId).submitted,0);
  }
  await assert.rejects(f.queue.receipt(f.id,f.body,{actorId:'main',profileId:'other'}),/not found/);
  assert.equal(f.store.snapshot().attempts.length,1);
});

test('email evidence requires previously saved exact-role status and does not authorize retry',async t=>{
  const f=await fixture(t);
  await f.store.mutate(s=>{s.applications.find(a=>a.id===f.id).employerStatus.subject='Your application for Examples - Engineer II';});
  const body=structuredClone(f.body);body.receipt.emailEvidence.subject='Your application for Examples - Engineer II';
  await assert.rejects(f.queue.receipt(f.id,body,identity),/exact-role/);
  await f.store.mutate(s=>{delete s.applications.find(a=>a.id===f.id).employerStatus;});
  await assert.rejects(f.queue.receipt(f.id,f.body,identity),/exact-role/);
  await assert.rejects(f.queue.startSubmission(f.id,{...scope,previewFingerprint:'a'.repeat(64)},identity),/do not repeat/);
});

test('authenticated HTTP email receipt preserves isolation and is idempotent',async t=>{
  const f=await fixture(t), server=createHttpServer({service:f.service,authenticate:r=>r.headers.authorization==='Bearer other'?{actorId:'other',profileId:'other'}:identity});
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${server.address().port}/v1/chrome-queue/${f.id}/receipt`;
  const send=token=>fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(f.body)});
  assert.equal((await send('other')).status,404);
  assert.equal((await send('owner')).status,200);
  assert.equal((await(await send('owner')).json()).duplicate,true);
  assert.equal(f.queue.list(identity.profileId).submitted,1);
});

test('linked ATS sender is supported without treating mail as an employer redirect',async t=>{
  const f=await fixture(t), state=f.store.snapshot(), application=state.applications.find(a=>a.id===f.id);
  const action={...application.finalAction,destination:'https://www.ycombinator.com/companies/example/jobs/abc-engineer'};
  const receipt=structuredClone(f.body.receipt);receipt.emailEvidence.sender=['workatastartup','ycombinator.com'].join('@');
  const opportunity=state.opportunities.find(o=>o.id===application.opportunityId),profile={contact:{email:'applicant@example.test'}};
  assert.equal(verifyEmailReceipt(receipt,application,opportunity,profile,action).kind,'verified_employer_email');
  assert.throws(()=>verifyEmailReceipt(receipt,application,opportunity,profile,{...action,destination:'https://ycombinator.com.lookalike.example/jobs/abc'}));
  application.employerStatus.observedAt=receipt.emailEvidence.receivedAt='2000-01-01T00:00:00Z';
  assert.throws(()=>verifyEmailReceipt(receipt,application,opportunity,profile,action));
});
