#!/usr/bin/env node
// Synthetic local/staging verification only. No employer, real profile or submission.
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {ApplicationService} from '../src/service.js';
import {draftPacket} from '../test/fixtures/draft-packet.js';
import {saveDraft} from '../src/application-drafts.js';

const store=await new SqliteStore(path.join(await mkdtemp(path.join(os.tmpdir(),'feedback-browser-')),'state.sqlite')).init();
let profile={contact:{firstName:'Verified Fixture'},applicationAnswers:{Availability:'Immediate'}};
const owner={profileId:'synthetic',actorId:'fixture-main'},main={sessionId:'fixture-chat'};
const service=new ApplicationService({store,config:{defaultMode:'full_time',execution:{workflow:'chrome_session'},modes:{full_time:{dailyApplicationCap:100}}},profiles:{get:async()=>structuredClone(profile)}});
const errors=[],requests=[];
let sequence=0;
async function add(value){
  const url=`https://employer.example/jobs/feedback-${sequence++}`;
  const draft=draftPacket(url);
  draft.fields=[{key:'availability',question:'Availability',kind:'text',required:true,value,status:value===null?'missing':'draft',evidence:[{kind:'profile_fact',reference:'Synthetic verified fact'}]}];
  draft.formObservation.complete=true;draft.formObservation.access='public';
  const {application}=await service.chromeQueue.add({url},owner);
  await store.mutate(s=>saveDraft(s.applications.find(a=>a.id===application.id),s.opportunities.find(o=>o.id===application.opportunityId),draft,profile,{workerId:'search-1'},new Date().toISOString()));
  return application.id;
}
async function learn(){
  const id=await add(null);await service.chromeQueue.claim(main,owner);
  const loaded=await service.applicationDrafts.load(id,owner),p=structuredClone(loaded.packet);
  p.fields[0].value='Immediate';p.fields[0].status='draft';p.formObservation.observedAt=new Date().toISOString();
  await service.applicationDrafts.review(id,{...main,revision:loaded.revision,fingerprint:loaded.fingerprint,packet:p},owner);
  await service.chromeQueue.checkpoint(id,{...main,kind:'captcha',message:'Synthetic held form',checkpoint:{answer:'Preserve this form'}},owner);
}
async function state(){return {learning:(await service.applicationDrafts.context(owner)).learning,attempts:store.snapshot().attempts.length,current:service.chromeQueue.list(owner.profileId).current?.status,profile};}
const html=`<!doctype html><html><head><meta charset="utf-8"><title>Draft Feedback Verification</title></head><body><h1>Draft feedback verification</h1><p>Isolated fixture. No employer or actual application.</p><label>Held form <input value="Preserve this form"></label><p><button id="learn">Review missed known answer</button><button id="covered">Next worker uses current fact</button><button id="missed">Next worker misses fact</button><button id="changed">Change current fact</button><button id="foreign">Other applicant context</button></p><p id="result" role="status"></p><pre id="state"></pre><script>async function refresh(){document.querySelector('#state').textContent=JSON.stringify(await(await fetch('/state')).json(),null,2)}for(const id of ['learn','covered','missed','changed','foreign'])document.querySelector('#'+id).onclick=async()=>{const r=await fetch('/action/'+id,{method:'POST'}),j=await r.json();document.querySelector('#result').textContent=r.ok?(id==='foreign'?'Other applicant reports: '+j.reports:'Saved '+id):'Error: '+j.error;await refresh()};refresh()</script></body></html>`;
const server=createServer(async(req,res)=>{requests.push({method:req.method,path:req.url});try{
  if(req.url==='/favicon.ico'){res.writeHead(204);return res.end()}
  if(req.url==='/state'||req.url==='/diagnostics'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(req.url==='/state'?await state():{errors,requests,...await state()}))}
  if(req.method==='POST'&&req.url.startsWith('/action/')){
    const action=req.url.slice(8);let result;
    if(action==='learn')await learn();
    else if(action==='covered')await add('Immediate');
    else if(action==='missed')await add(null);
    else if(action==='changed')profile.applicationAnswers.Availability='Later';
    else if(action==='foreign')result=(await service.applicationDrafts.context({profileId:'other',actorId:'other'})).learning;
    else throw Error('Unknown action');
    res.setHeader('content-type','application/json');return res.end(JSON.stringify(result??await state()));
  }
  res.setHeader('content-type','text/html');res.end(html);
}catch(e){errors.push({message:e.message,path:req.url});res.writeHead(e.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}))}});
server.listen(Number(process.env.FIXTURE_PORT??4398),'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,isolated:true})));
