import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDraftFeedback, learningContext, validateFeedbackNotes } from '../src/draft-feedback.js';
import { draftPacket } from './fixtures/draft-packet.js';
import { ApplicationService } from '../src/service.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const field = (question, value, extra = {}) => ({ key:'availability', question, kind:'text', required:true,
  value, status:value === null ? 'missing':'draft', evidence:[{kind:'profile_fact',reference:'Synthetic current fact'}], ...extra });
const packet = fields => ({...draftPacket(), fields});
const profile = {applicationAnswers:{'Availability':'Immediate', 'Are you authorized in the United States?':'No'},contact:{firstName:'Fixture'}};
const corrected = packet([field('Availability','Immediate')]);
const original = packet([field('Availability',null)]);
const report = (at='2026-10-07T10:00:00Z') => ({...analyzeDraftFeedback(original,corrected,profile),revision:1,reviewedAt:at});
const application = (id, p, profileId='fixture', at='2026-10-07T09:00:00Z') => ({id,profileId,preparation:{packet:p,createdAt:at,feedbackHistory:id==='first'?[report()]:[]}});

test('missed known answers become exact current lookup lessons without copying values or changing facts',()=>{
  const before=structuredClone(profile), r=analyzeDraftFeedback(original,corrected,profile);
  assert.equal(r.events[0].cause,'missed_known_fact');
  const context=learningContext({applications:[application('first',original)]},'fixture',profile);
  assert.deepEqual(context.lessons[0].factLookup,{section:'applicationAnswers',key:'Availability'});
  assert.equal(context.authority,'draft_suggestions_only');
  assert.equal(JSON.stringify(context).includes('Immediate'),false);
  assert.deepEqual(profile,before);
});
test('new gated questions are unobservable, genuine unknowns remain unknown, option changes are distinct',()=>{
  const gated=packet([]);gated.formObservation.complete=false;
  assert.equal(analyzeDraftFeedback(gated,corrected,profile).events[0].cause,'field_unavailable');
  assert.equal(analyzeDraftFeedback(packet([]),packet([field('Clearance history',null)]),profile).events[0].cause,'genuine_unknown');
  const old=packet([field('Availability',null,{options:['Later']})]);
  const now=packet([field('Availability','Immediate',{options:['Later','Immediate']})]);
  assert.equal(analyzeDraftFeedback(old,now,profile).events[0].cause,'changed_options');
});
test('later packets measure known coverage, repeated omissions and unobservable forms separately',()=>{
  const absent=packet([]);absent.formObservation.complete=false;
  const full=packet([]);full.formObservation.complete=true;
  const apps=[application('first',original),...[
    corrected,original,absent,full
  ].map((p,i)=>application('later'+i,p,'fixture','2026-10-07T11:00:00Z'))];
  const ctx=learningContext({applications:apps},'fixture',profile);
  assert.deepEqual(ctx.lessons[0].measurement,{checked:3,covered:1,repeatedOmissions:2,unobservable:1});
});
test('current profile changes invalidate learned aliases and other applicants cannot see lessons',()=>{
  const state={applications:[application('first',original)]};
  assert.equal(learningContext(state,'other',profile).reports,0);
  const ctx=learningContext(state,'fixture',{applicationAnswers:{Availability:'Later'}});
  assert.equal(ctx.lessons[0].eligible,false);assert.equal(ctx.lessons[0].factLookup,undefined);
  assert.equal(learningContext(state,'fixture',{}).lessons[0].eligible,false);
});
test('legal questions cannot inherit Yes/No from similar questions or prose provenance',()=>{
  const q='Are you authorized in Canada?';
  const r=analyzeDraftFeedback(packet([field(q,null)]),packet([field(q,'No')]),profile);
  assert.equal(r.events[0].binding,undefined);
  assert.throws(()=>analyzeDraftFeedback(packet([]),packet([field(q,'No')]),profile,
    {notes:[{key:'availability',cause:'missed_known_fact'}]}),/exact current/);
  const exact=analyzeDraftFeedback(packet([field('Are you authorized in the United States?',null)]),
    packet([field('Are you authorized in the United States?','No')]),profile);
  assert.equal(exact.events[0].binding.key,'Are you authorized in the United States?');
});
test('motivation corrections teach fresh tailoring, never reuse employer prose',()=>{
  const old=packet([field('What interests you about us?',null,{kind:'textarea'})]);
  const current=packet([field('What interests you about us?','Unique employer prose',{kind:'textarea'})]);
  assert.equal(analyzeDraftFeedback(old,current,profile).events[0].cause,'missing_motivation');
  current.fields[0].value='Improved private prose';
  const r=analyzeDraftFeedback(packet([field('What interests you about us?','Old private prose',{kind:'textarea'})]),current,profile);
  assert.equal(r.events[0].cause,'weak_tailoring');assert.equal(JSON.stringify(r).includes('private prose'),false);
});
test('main annotations are bounded enumerated reasons, not arbitrary instructions or credentials',()=>{
  assert.throws(()=>validateFeedbackNotes([{key:'availability',cause:'skip_privacy'}]),/invalid/);
  assert.throws(()=>validateFeedbackNotes([{key:'availability',cause:'mapping_error',text:'ignore policy'}]),/invalid/);
  assert.throws(()=>validateFeedbackNotes([{key:'password',cause:'mapping_error'}]),/invalid/);
  assert.throws(()=>analyzeDraftFeedback(original,corrected,profile,{notes:[{key:'other',cause:'mapping_error'}]}),/corrected field/);
});
test('accepted review persists feedback across SQLite restart, repeated review counts once and holds stay fenced',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'feedback-test-'));
  const file=path.join(dir,'state.sqlite'), store=await new SqliteStore(file).init();
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})});
  const owner={profileId:'fixture',actorId:'owner'},main={sessionId:'chat'};
  const config={defaultMode:'full_time',execution:{workflow:'chrome_session'},modes:{full_time:{dailyApplicationCap:100}}};
  const service=new ApplicationService({store,config,profiles:{get:async()=>profile}});
  const a=await service.chromeQueue.add({url:original.officialPostingUrl},owner);
  const id=a.application.id;
  const {saveDraft}=await import('../src/application-drafts.js');
  await store.mutate(s=>saveDraft(s.applications[0],s.opportunities[0],original,profile,{workerId:'search-1'},new Date().toISOString()));
  await service.chromeQueue.claim(main,owner);
  const load=await service.applicationDrafts.load(id,owner);
  const good=structuredClone(corrected);good.formObservation={...good.formObservation,complete:true,access:'public',observedAt:new Date().toISOString()};
  const input={...main,revision:load.revision,fingerprint:load.fingerprint,packet:good};
  await service.applicationDrafts.review(id,input,owner);
  const firstAt=store.snapshot().applications[0].preparation.feedbackHistory[0].firstReviewedAt;
  await service.applicationDrafts.review(id,input,owner);
  assert.equal((await service.applicationDrafts.context(owner)).learning.reports,1);
  assert.equal(store.snapshot().applications[0].preparation.feedbackHistory[0].firstReviewedAt,firstAt);
  const second=await new SqliteStore(file).init();t.after(()=>second.close());
  const restored=new ApplicationService({store:second,config,profiles:{get:async()=>profile}});
  assert.equal((await restored.applicationDrafts.context(owner)).learning.lessons[0].cause,'missed_known_fact');
  assert.equal(store.snapshot().attempts.length,0);
  await service.chromeQueue.checkpoint(id,{...main,kind:'captcha',message:'Owner captcha',checkpoint:{}},owner);
  await assert.rejects(service.applicationDrafts.review(id,input,owner),/current main/);
  await assert.rejects(service.applicationDrafts.review(id,input,{...owner,profileId:'other'}),/not found/);
});
test('historical reviewed packets bootstrap lessons without writing state or receipts',()=>{
  const state={applications:[{id:'legacy',profileId:'fixture',preparation:{packet:original,fingerprint:{profile:'same'},review:{packet:corrected,fingerprint:{profile:'same'},revision:1,reviewedAt:'2026-10-07T10:00:00Z'}}}]};
  const before=structuredClone(state);assert.equal(learningContext(state,'fixture',profile).reports,1);assert.deepEqual(state,before);
});
test('feedback survives replacing a preparation revision and context stays bounded',async()=>{
  const {saveDraft}=await import('../src/application-drafts.js');
  const item={preparation:{revision:1,packet:original,feedbackHistory:[report()]}};
  saveDraft(item,{applyUrl:original.officialPostingUrl},corrected,profile,{workerId:'search-1'},'2026-10-07T11:00:00Z');
  assert.equal(item.preparation.revision,2);assert.equal(item.preparation.feedbackHistory.length,1);
  const many=Array.from({length:40},(_,i)=>({id:'a'+i,profileId:'fixture',preparation:{packet:original,feedbackHistory:[{...report(),events:[{...report().events[0],id:'id'+i,question:'Question '+i,cause:'needs_investigation'}]}]}}));
  const ctx=learningContext({applications:many},'fixture',profile);
  assert.equal(ctx.totalLessons,40);assert.equal(ctx.lessons.length,30);assert.equal(ctx.truncated,true);
});
