// Isolated staging UI exercises the API and the actual dashboard collector.
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {SqliteStore} from '../src/sqlite-store.js';
import {ApplicationService} from '../src/service.js';
import {createHttpServer} from '../src/http.js';
const {snapshot}=await import(pathToFileURL(process.argv[2]).href);
const dir=await mkdtemp(path.join(os.tmpdir(),'redirect-receipt-fixture-'));
const store=await new SqliteStore(path.join(dir,'state.sqlite')).init();
const profileId=process.env.PREVIEW_PROFILE_ID??'synthetic-applicant';
const identity={actorId:'synthetic-main',profileId},scope={sessionId:'synthetic-chat'};
const source='https://jobs.lever.co/example/11111111-1111-4111-8111-111111111111/apply';
const final='https://employer.example/thanks?application=fixture';
const service=new ApplicationService({store,config:{defaultMode:'full_time',modes:{full_time:{dailyApplicationCap:10}}},profiles:{get:async()=>({})},
 receiptFetchImpl:async()=>new Response('<a href="http://employer.example">Example Home Page</a>',{headers:{'content-type':'text/html'}})});
const first=(await service.chromeQueue.add({url:source,company:'Example',title:'Engineer'},identity)).application;
await service.chromeQueue.add({url:'https://employer.example/next',company:'Example',title:'Next Engineer'},identity);
await service.chromeQueue.claim(scope,identity);
const review=await service.chromeQueue.review(first.id,{...scope,authorizationSource:'Synthetic routine submission delegation',preview:{company:'Example',title:'Engineer',destination:source,officialPostingReviewed:true,resumeUploaded:true,fit:{decision:'relevant',reason:'Synthetic core match'},filled:[{key:'name',label:'Name',value:'Example Applicant',required:true,source:'Synthetic profile'}],unfilled:[]}},identity);
const attempt=await service.chromeQueue.startSubmission(first.id,{...scope,previewFingerprint:review.previewFingerprint},identity);
await service.chromeQueue.checkpoint(first.id,{...scope,kind:'captcha',message:'Synthetic owner handoff'},identity);
const api=createHttpServer({service,authenticate:()=>identity});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
const proof={...scope,attemptId:attempt.attemptId,redirectEvidence:{sourceUrl:source,employerUrl:'https://employer.example/',linkText:'Example Home Page'},receipt:{manuallyVerified:true,finalUrl:final,successText:'Thank you for submitting your application',observedAt:new Date().toISOString(),visualReceiptHash:'a'.repeat(64)}};
const state=()=>({stats:snapshot(service.list('applications',profileId),service.list('opportunities',profileId)).stats,current:service.chromeQueue.list(profileId).current?.opportunity?.title??null,completed:service.chromeQueue.list(profileId).submitted,attempts:store.snapshot().attempts.length});
const app=createServer(async(req,res)=>{
 if(req.url==='/favicon.ico'){res.writeHead(204);return res.end()}
 if(req.url==='/state'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(state()))}
 if(req.method==='POST'){
  const body=req.url==='/next'?scope:{...proof,...(req.url==='/unrelated'?{receipt:{...proof.receipt,finalUrl:'https://unrelated.example/thanks'}}:{})};
  const url=req.url==='/next'?'/v1/chrome-queue/next':`/v1/chrome-queue/${first.id}/receipt`;
  const r=await fetch(`http://127.0.0.1:${api.address().port}${url}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  res.writeHead(r.status,{'content-type':'application/json'});const result=await r.json();return res.end(JSON.stringify(r.ok?{ok:true,duplicate:result.duplicate??false}:result));
 }
 res.setHeader('content-type','text/html');res.end(`<!doctype html><html><title>Receipt redirect staging verification</title><body><h1>Receipt redirect verification</h1><p>Isolated synthetic state. No employer is contacted.</p><p>Sent today: <strong id="count">0</strong></p><p>Attempts: <strong id="attempts">1</strong></p><button onclick="act('/record')">Record verified employer redirect</button><button onclick="act('/unrelated')">Record unrelated destination</button><button onclick="act('/next')">Next application</button><p id="result" role="status"></p><pre id="state"></pre><script>async function refresh(){const s=await(await fetch('/state')).json();document.querySelector('#count').textContent=s.stats.sentToday;document.querySelector('#attempts').textContent=s.attempts;document.querySelector('#state').textContent=JSON.stringify(s,null,2)}async function act(url){const r=await fetch(url,{method:'POST'});const j=await r.json();document.querySelector('#result').textContent=r.ok?(url==='/next'?'Next role claimed':j.duplicate?'Duplicate: no extra count':'Employer confirmation recorded'):'Rejected: '+j.error;await refresh()}refresh()</script></body></html>`);
});
await new Promise(r=>app.listen(Number(process.env.FIXTURE_PORT??4398),'127.0.0.1',r));
console.log(JSON.stringify({fixturePort:app.address().port,isolated:true}));
async function stop(){await Promise.all([new Promise(r=>api.close(r)),new Promise(r=>app.close(r))]);store.close();await rm(dir,{recursive:true,force:true});process.exit()}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
