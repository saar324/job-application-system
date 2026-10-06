import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApplicationService } from '../src/service.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { createHttpServer } from '../src/http.js';
const {snapshot}=await import(pathToFileURL(process.argv[2]).href);
const directory=await mkdtemp(path.join(os.tmpdir(),'owner-submission-preview-'));
const store=await new SqliteStore(path.join(directory,'state.sqlite')).init();
const profileId=process.env.PREVIEW_PROFILE_ID??'local-profile';
const identity={actorId:'fixture',profileId};
const service=new ApplicationService({store,config:{defaultMode:'full_time'}});
const api=createHttpServer({service,authenticate:()=>identity});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
const source={recordKey:'fixture/one',company:'Example Company',title:'Software Engineer',submissionDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),observedAt:new Date().toISOString(),evidence:{source:'owner_provided_linkedin',successText:'Application status\nApplication submitted\nnow',reference:'Disposable browser test fixture',sha256:'a'.repeat(64)}};
const app=createServer(async(req,res)=>{
 if(req.url==='/counts'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(snapshot(service.list('applications',profileId),service.list('opportunities',profileId)).stats));}
 if(req.method==='POST'){
  const body={...source,...(req.url==='/invalid'?{recordKey:'fixture/review',evidence:{...source.evidence,successText:'Review your application'}}:{})};
  const r=await fetch(`http://127.0.0.1:${api.address().port}/v1/external-submissions`,{method:'POST',body:JSON.stringify(body)});res.writeHead(r.status,{'content-type':'application/json'});return res.end(await r.text());
 }
 res.setHeader('content-type','text/html');res.end(`<!doctype html><html><title>Submission import verification</title><body><h1>LinkedIn confirmation import</h1><p>Sent today: <strong id="count">0</strong></p><button onclick="log('/import')">Import confirmation</button><button onclick="log('/invalid')">Import review screen</button><p id="result"></p><script>async function log(url){const r=await fetch(url,{method:'POST'});const p=await r.json();document.querySelector('#result').textContent=r.ok?(p.duplicate?'Duplicate saved. No extra count.':'Confirmation saved.'):'Rejected: '+p.error;const counts=await(await fetch('/counts')).json();document.querySelector('#count').textContent=counts.sentToday}</script></body></html>`);
});
await new Promise(r=>app.listen(Number(process.env.PREVIEW_PORT??4399),'127.0.0.1',r));console.log('Submission preview ready on port '+app.address().port);
async function stop(){await Promise.all([new Promise(r=>api.close(r)),new Promise(r=>app.close(r))]);store.close();await rm(directory,{recursive:true,force:true});process.exit();}process.on('SIGINT',stop);process.on('SIGTERM',stop);
