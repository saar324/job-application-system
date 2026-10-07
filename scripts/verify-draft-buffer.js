#!/usr/bin/env node
// Isolated interactive fixture. No real applicant, credentials or employer requests.
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/sqlite-store.js';
import { ApplicationService } from '../src/service.js';
import { draftPacket } from '../test/fixtures/draft-packet.js';
import { buildFillPlan } from '../skills/job-application/scripts/draft-fill-plan.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'draft-browser-fixture-'));
const store = await new SqliteStore(path.join(dir, 'state.sqlite')).init();
const owner = { actorId:'fixture-main', profileId:'synthetic' }, main = { sessionId:'fixture-chat' };
const service = new ApplicationService({store, config:{defaultMode:'full_time',execution:{workflow:'chrome_session'},modes:{full_time:{dailyApplicationCap:100}}}, profiles:{get:async()=>({contact:{firstName:'Verified Fixture'}})}});
const c = service.searchCoordinator;
const discovery = {considerCandidate:async input=>{const o=await service.addOpportunity(input.candidate,owner,{reviewedDiscovery:true});return {status:'ready',opportunityId:o.id}}};
let leases, next=0, plan=null;
const errors=[], requests=[];
async function enqueue(lease){
  const url=`https://employer.example/jobs/${next++}`, context=await service.applicationDrafts.context(owner);
  const draft=draftPacket(url); draft.fields[0].value='Uncorrected Suggestion';
  draft.fields.push({key:'availability',question:'Availability',kind:'select',required:true,options:['Immediate','Later'],value:'Immediate',status:'draft',evidence:[{kind:'owner_fact',reference:'Synthetic fixture authorization'}]});
  return c.enqueue({...main,workerId:lease.workerId,leaseId:lease.id,officialPostingReviewed:true,
    candidate:{source:lease.sourceId,title:'Engineer '+next,company:'Synthetic Employer',description:'Remote production engineer',applyUrl:url},fit:{decision:'relevant',reason:'Synthetic verified fit'},draft,profileFingerprint:context.profileFingerprint},owner,discovery);
}
const state=()=>({buffer:c.status(owner).buffer,sources:c.status(owner).session?.sources.map(s=>({id:s.id,worker:s.lease?.workerId})),current:service.chromeQueue.list(owner.profileId).current?.status,attempts:store.snapshot().attempts.length,plan});
const html=`<!doctype html><html><head><meta charset="utf-8"><title>Draft Buffer Verification</title></head><body>
<h1>Draft buffer verification</h1><p>Isolated synthetic applications. No submissions.</p>
<label>Held form answer <input id="held" value="Keep this answer"></label>
<p><button id="start">Start two workers</button><button id="refill">Refill to 30</button><button id="consume29">Consume to 29</button><button id="consume20">Consume to 20</button></p>
<label>First Name <input id="name" value=""></label><label>Availability <select id="availability"><option value="">Choose</option><option>Immediate</option><option>Later</option></select></label>
<p><button id="correct">Review and correct draft</button><button id="fill">Fill corrected batch</button><button id="edge">Check changed option</button></p>
<pre id="state"></pre><p role="alert" id="error"></p><script>
async function refresh(){document.querySelector('#state').textContent=JSON.stringify(await(await fetch('/state')).json(),null,2)}
for(const id of ['start','refill','consume29','consume20','correct','fill','edge'])document.querySelector('#'+id).onclick=async()=>{try{const r=await fetch('/action/'+id,{method:'POST'});const j=await r.json();if(!r.ok)throw Error(j.error);if(id==='fill'&&j.plan.readyForBatchFill){for(const f of j.plan.fields){const el=document.querySelector(f.locator.value);el.value=f.action==='selectOption'?f.value.label:f.value;el.dispatchEvent(new Event('input',{bubbles:true}))}}await refresh()}catch(e){document.querySelector('#error').textContent=e.message}};refresh();
</script></body></html>`;
const server=createServer(async(req,res)=>{
  requests.push({method:req.method,path:req.url});
  try{
    if(req.url==='/favicon.ico'){res.writeHead(204);return res.end()}
    if(req.url==='/state'||req.url==='/diagnostics'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(req.url==='/state'?state():{requests,errors,...state()}))}
    if(req.method==='POST'&&req.url.startsWith('/action/')){
      const action=req.url.slice(8);
      if(action==='start'){
        await c.start({...main,sources:['alpha','beta']},owner);
        leases=await Promise.all(['search-1','search-2'].map(workerId=>c.claim({...main,workerId},owner)));
        for(let i=0;i<20;i++)await enqueue(leases[i%2].lease);
        const {application}=await service.chromeQueue.claim(main,owner);
        await service.chromeQueue.checkpoint(application.id,{...main,kind:'captcha',message:'Synthetic held form',checkpoint:{answer:'Keep this answer'}},owner);
      }else if(action==='refill'){
        while((await c.control(main,owner)).buffer.shouldSearch)await enqueue(leases[next%2].lease);
      }else if(action==='consume29'||action==='consume20'){
        const target=action==='consume29'?29:20;
        do{const current=service.chromeQueue.list(owner.profileId).current;
          await service.chromeQueue.skip(current.id,{...main,reason:'Synthetic fixture consumption only'},owner);
          await service.chromeQueue.claim(main,owner);
        }while(service.chromeQueue.list(owner.profileId).pending>target);
        await c.control(main,owner);
      }else if(action==='correct'||action==='edge'){
        const application=service.chromeQueue.list(owner.profileId).current;
        if(application.status==='waiting_owner')await service.chromeQueue.resume(application.id,{...main,resolution:'Synthetic fixture checkpoint resolved'},owner);
        const d=await service.applicationDrafts.load(application.id,owner), packet=structuredClone(d.packet);
        packet.fields[0].value='Corrected Fixture'; packet.fields[0].required=true;
        packet.formObservation={url:d.officialPostingUrl,observedAt:new Date().toISOString(),complete:true,access:'public'};
        const reviewed=await service.applicationDrafts.review(application.id,{...main,revision:d.revision,fingerprint:d.fingerprint,packet},owner);
        const accepted={...d,correctedPacket:packet,readyToFill:reviewed.readyToFill};
        plan=buildFillPlan({draft:accepted,live:{url:d.officialPostingUrl,observedAt:new Date().toISOString(),fields:[
          {key:'name',question:'First Name',kind:'text',required:true,locator:{by:'selector',value:'#name'}},
          {key:'availability',question:'Availability',kind:'select',required:true,options:action==='edge'?['Later']:['Immediate','Later'],nativeSelect:true,locator:{by:'selector',value:'#availability'}}]}});
      }else if(action==='fill'){if(!plan?.readyForBatchFill)throw Error('Correct the draft before filling')}
      else throw Error('Unknown fixture action');
      res.setHeader('content-type','application/json');return res.end(JSON.stringify(state()));
    }
    res.setHeader('content-type','text/html');res.end(html);
  }catch(e){errors.push({path:req.url,message:e.message});res.writeHead(e.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}))}
});
server.listen(Number(process.env.FIXTURE_PORT??4397),'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,isolated:true})));
