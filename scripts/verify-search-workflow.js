#!/usr/bin/env node
// Synthetic browser fixture; isolated state, no real jobs, credentials or employer submission.
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/sqlite-store.js';
import { ApplicationService } from '../src/service.js';
import { SearchCoordinator } from '../src/discovery/search-coordinator.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'search-browser-fixture-'));
const store = await new SqliteStore(path.join(dir, 'state.sqlite')).init();
const owner = { actorId:'fixture-main',profileId:'synthetic-applicant' }, main = { sessionId:'fixture-chat' };
const service = new ApplicationService({ store,config:{ defaultMode:'full_time',execution:{workflow:'chrome_session'},modes:{full_time:{dailyApplicationCap:10}} },profiles:{get:async()=>({})} });
let now = Date.parse('2026-10-07T20:50:00Z');
const coordinator = new SearchCoordinator(service,{clock:()=>now});
const discovery = { considerCandidate:async input => { const opportunity = await service.addOpportunity(input.candidate,owner,{reviewedDiscovery:true}); return {status:'ready',opportunityId:opportunity.id}; } };
const scope = (worker,lease) => ({...main,workerId:worker,leaseId:lease.id});
const errors=[], requests=[];
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Search Coordination Fixture</title></head><body>
<h1>Two search workers, one form</h1><p>Synthetic isolated fixture. No real application is sent.</p>
<label>Current form answer <input id="answer" value="Keep this answer"></label>
<button id="start">Start two workers</button><button id="queue">Queue same role from both sources</button>
<button id="rotate">Rotate weak source</button><button id="day">Next Sofia day</button><button id="stop">Stop search</button>
<pre id="state"></pre><p id="error" role="alert"></p><script>
async function refresh(){document.querySelector('#state').textContent=JSON.stringify(await(await fetch('/state')).json(),null,2)}
for(const id of ['start','queue','rotate','day','stop'])document.querySelector('#'+id).onclick=async()=>{document.querySelector('#error').textContent='';const r=await fetch('/action/'+id,{method:'POST'});const j=await r.json();if(!r.ok)document.querySelector('#error').textContent=j.error;await refresh()};refresh();
</script></body></html>`;
let leases;
const server = createServer(async(req,res)=>{
  requests.push({method:req.method,path:req.url});
  const state = ()=>({ search:coordinator.status(owner),queue:service.chromeQueue.list(owner.profileId),attempts:store.snapshot().attempts.length });
  try {
    if(req.url==='/favicon.ico'){res.writeHead(204);return res.end()}
    if(req.url==='/state'||req.url==='/diagnostics'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(req.url==='/state'?state():{requests,errors,...state()}))}
    if(req.method==='POST'&&req.url.startsWith('/action/')){
      const action=req.url.slice(8);
      if(action==='start'){
        await coordinator.start({...main,sources:['alpha','beta','gamma']},owner);
        const application=(await service.chromeQueue.add({url:'https://employer.example/current'},owner)).application;
        await service.chromeQueue.claim(main,owner);
        await service.chromeQueue.checkpoint(application.id,{...main,kind:'captcha',message:'Synthetic owner CAPTCHA',checkpoint:{fields:[{key:'answer',value:'Keep this answer'}]}},owner);
        leases=await Promise.all(['search-1','search-2'].map(workerId=>coordinator.claim({...main,workerId},owner)));
      }else if(action==='queue'){
        await Promise.all(leases.map(({lease},i)=>coordinator.enqueue({...scope('search-'+(i+1),lease),officialPostingReviewed:true,
          candidate:{source:lease.sourceId,title:'Remote Engineer',company:'Synthetic Employer',description:'Full current remote role.',applyUrl:'https://employer.example/new'},fit:{decision:'relevant',reason:'Synthetic role fit'}},owner,discovery)));
      }else if(action==='rotate'){
        const input=scope('search-1',leases[0].lease);
        await coordinator.progress({...input,reviewed:5,pageComplete:true},owner);
        await coordinator.progress({...input,reviewed:5,pageComplete:true},owner);
        await coordinator.finish({...input,outcome:'low_quality',reason:'Two focused pages without unseen strong matches'},owner);
        leases[0]=await coordinator.claim({...main,workerId:'search-1'},owner);
      }else if(action==='day'){
        for(let i=0;i<2;i++)await coordinator.finish({...scope('search-'+(i+1),leases[i].lease),outcome:'pass_complete',reason:'Synthetic daily bounded pass finished'},owner);
        now=Date.parse('2026-10-07T21:01:00Z');
        leases=await Promise.all(['search-1','search-2'].map(workerId=>coordinator.claim({...main,workerId},owner)));
      }else if(action==='stop')await coordinator.stop(main,owner);
      else throw new Error('unknown fixture action');
      res.setHeader('content-type','application/json');return res.end(JSON.stringify(state()));
    }
    res.setHeader('content-type','text/html');res.end(html);
  }catch(error){errors.push({path:req.url,message:error.message});res.writeHead(error.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
server.listen(Number(process.env.FIXTURE_PORT??4396),'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,isolated:true})));
