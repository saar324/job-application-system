// Isolated browser fixture. Never calls an employer or uses live applicant state.
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {SqliteStore} from '../src/sqlite-store.js';
import {ApplicationService} from '../src/service.js';
import {createHttpServer} from '../src/http.js';
const {snapshot}=await import(pathToFileURL(process.argv[2]).href);
const dir=await mkdtemp(path.join(os.tmpdir(),'owner-browser-fixture-'));
const store=await new SqliteStore(path.join(dir,'state.sqlite')).init();
const profileId=process.env.PREVIEW_PROFILE_ID??'synthetic-applicant';
const identity={actorId:'synthetic-main',profileId},scope={sessionId:'synthetic-chat'};
const service=new ApplicationService({store,config:{defaultMode:'full_time',modes:{full_time:{dailyApplicationCap:10}}},profiles:{get:async()=>({})}});
const first=(await service.chromeQueue.add({url:'https://job-boards.greenhouse.io/example/jobs/123',company:'Synthetic Employer',title:'First Engineer'},identity)).application;
await service.chromeQueue.add({url:'https://job-boards.greenhouse.io/example/jobs/456',company:'Synthetic Employer',title:'Next Engineer'},identity);
await service.chromeQueue.claim(scope,identity);
await service.chromeQueue.checkpoint(first.id,{...scope,kind:'tool_permission',message:'Synthetic privacy hold'},identity);
const api=createHttpServer({service,authenticate:()=>identity});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
const observedAt=new Date().toISOString();
const proof={...scope,ownerSubmitted:true,recordKey:'fixture/browser/123',observedAt,
 submissionDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(observedAt)),
 finalUrl:'https://job-boards.greenhouse.io/example/jobs/123/confirmation',
 evidence:{source:'owner_provided_employer_confirmation',successText:'Your application has been received.',reference:'Synthetic owner confirmation',sha256:'a'.repeat(64)}};
const state=()=>({stats:snapshot(service.list('applications',profileId),service.list('opportunities',profileId)).stats,
 current:service.chromeQueue.list(profileId).current?.id??null,completed:service.chromeQueue.list(profileId).submitted,attempts:store.snapshot().attempts.length});
const app=createServer(async(req,res)=>{
 if(req.url==='/favicon.ico'){res.writeHead(204);return res.end()}
 if(req.url==='/state'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(state()))}
 if(req.method==='POST'){
  const body=req.url==='/next'?scope:{...proof,...(req.url==='/wrong'?{finalUrl:'https://job-boards.greenhouse.io/example/jobs/456/confirmation'}:{})};
  const url=req.url==='/next'?'/v1/chrome-queue/next':`/v1/chrome-queue/${first.id}/owner-receipt`;
  const r=await fetch(`http://127.0.0.1:${api.address().port}${url}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  res.writeHead(r.status,{'content-type':'application/json'});return res.end(await r.text());
 }
 res.setHeader('content-type','text/html');res.end(`<!doctype html><html><title>Owner receipt verification</title><body><h1>Owner browser submission</h1><p>Synthetic isolated state. No employer is contacted.</p><p>Sent today: <strong id="count">0</strong></p><p>Agent attempts: <strong id="attempts">0</strong></p><button onclick="act('/record')">Record confirmation</button><button onclick="act('/wrong')">Record wrong role</button><button onclick="act('/next')">Next application</button><p id="result" role="status"></p><pre id="state"></pre><script>async function refresh(){const s=await(await fetch('/state')).json();document.querySelector('#count').textContent=s.stats.sentToday;document.querySelector('#attempts').textContent=s.attempts;document.querySelector('#state').textContent=JSON.stringify(s,null,2)}async function act(url){const r=await fetch(url,{method:'POST'});const j=await r.json();document.querySelector('#result').textContent=r.ok?(url==='/next'?'Next role claimed':j.duplicate?'Duplicate: no extra count':'Owner confirmation recorded'):'Rejected: '+j.error;await refresh()}refresh()</script></body></html>`);
});
await new Promise(r=>app.listen(Number(process.env.FIXTURE_PORT??4397),'127.0.0.1',r));
console.log(JSON.stringify({fixturePort:app.address().port,firstApplicationId:first.id,isolated:true}));
async function stop(){await Promise.all([new Promise(r=>api.close(r)),new Promise(r=>app.close(r))]);store.close();await rm(dir,{recursive:true,force:true});process.exit()}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
