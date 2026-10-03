#!/usr/bin/env node
// Isolated synthetic browser fixture. Never connects to an employer or real applicant state.
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/sqlite-store.js';
import { ApplicationService } from '../src/service.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'chrome-session-fixture-'));
const store = await new SqliteStore(path.join(dir, 'fixture.sqlite')).init();
const identity = { actorId: 'fixture-session', profileId: 'synthetic-applicant' };
const sessionId = 'fixture-chat';
const service = new ApplicationService({ store, config: { defaultMode:'full_time', execution: { workflow:'chrome_session', maxApplicationsPerDay:10 },
  modes: { full_time: { dailyApplicationCap:10 } } }, adapter: { name:'chrome_session' }, profiles: { get:async()=>({ applicationAnswers:{} }) } });
await writeFile(path.join(dir,'fixture-cv.txt'), 'Synthetic Applicant CV. Isolated browser verification only.');
const requests = [], errors = [];
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Chrome Application Workflow Fixture</title><style>
body{font:17px system-ui;max-width:850px;margin:30px auto;padding:20px}button,input{font:inherit;margin:8px 6px;padding:9px}label{display:block}pre{white-space:pre-wrap;background:#f4f5f7;padding:16px}#notice{font-weight:600;color:#064e3b}#issue{color:#9b1c1c}</style></head><body>
<h1>Chrome Application Workflow Fixture</h1><p>Synthetic applicant and employer. No real application is sent.</p>
<label>Job link <input id="link" value="https://employer.example/jobs/1" size="45"></label><button id="add">Queue link</button><button id="next">Start next application</button>
<pre id="state">Loading queue</pre><p id="notice"></p><p id="issue" role="alert"></p>
<section id="form"><h2>Current application</h2><label>Applicant name <input id="name" value="Synthetic Applicant"></label><label>Email <input id="email" value="synthetic@example.test"></label><label>Current CV <input id="cv" type="file" accept=".txt"></label>
<button id="pause">Pause for missing information</button><label>Owner answer <input id="answer"></label><button id="resume">Resume current application</button>
<button id="review">Review complete form</button><button id="submit">Submit fixture application</button><button id="record">Record verified fixture receipt</button></section>
<script>
let current=null,review=null,attempt=null,success=null;
async function call(action,body={}){const r=await fetch('/api/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error);return j}
async function state(){const j=await(await fetch('/state')).json();current=j.current;document.querySelector('#state').textContent='Pending: '+j.pending+' | Verified fixture receipts: '+j.submitted+'\\nCurrent: '+(current?current.opportunity.applyUrl+' | '+current.status:'none');return j}
function bind(id,fn){document.querySelector('#'+id).onclick=async()=>{document.querySelector('#issue').textContent='';try{await fn();await state()}catch(e){document.querySelector('#issue').textContent=e.message;await state()}}}
bind('add',async()=>{await call('add',{url:document.querySelector('#link').value});document.querySelector('#notice').textContent='Link saved without opening a form'});
bind('next',async()=>{const j=await call('claim',{sessionId:'${sessionId}'});document.querySelector('#notice').textContent=j.waiting?'Waiting for owner. Later jobs stay queued.':'Current application claimed'});
bind('pause',async()=>{await call('checkpoint',{id:current.id,sessionId:'${sessionId}',kind:'missing_fact',message:'What is the start date?',checkpoint:{fields:[{key:'name',value:document.querySelector('#name').value}]}});document.querySelector('#notice').textContent='Stopped. Waiting for owner start date. Form remains open.'});
bind('resume',async()=>{await call('resume',{id:current.id,sessionId:'${sessionId}',resolution:document.querySelector('#answer').value});document.querySelector('#notice').textContent='Owner answer saved. Resumed same application.'});
bind('review',async()=>{review=await call('review',{id:current.id,sessionId:'${sessionId}',authorizationSource:'Synthetic owner delegated routine final review',preview:{company:'Synthetic Employer',title:'Fixture Engineer',destination:'https://employer.example/apply',officialPostingReviewed:true,resumeUploaded:document.querySelector('#cv').files.length===1,fit:{decision:'relevant',reason:'Synthetic role matches fixture profile'},filled:[{key:'name',label:'Name',value:document.querySelector('#name').value,source:'synthetic profile',required:true},{key:'email',label:'Email',value:document.querySelector('#email').value,source:'synthetic profile',required:true}],unfilled:[]}});document.querySelector('#notice').textContent='Complete review saved. No owner approval prompt.'});
bind('submit',async()=>{attempt=await call('startSubmission',{id:current.id,sessionId:'${sessionId}',previewFingerprint:review?.previewFingerprint});success={manuallyVerified:true,finalUrl:'https://employer.example/thanks',successText:'Synthetic employer received this fixture application',observedAt:new Date().toISOString(),visualReceiptHash:'c'.repeat(64)};document.querySelector('#notice').textContent=success.successText;document.querySelector('#submit').disabled=true});
bind('record',async()=>{await call('receipt',{id:current.id,sessionId:'${sessionId}',attemptId:attempt.attemptId,receipt:success});document.querySelector('#notice').textContent='Verified fixture receipt recorded. Next queued job is available.';review=attempt=success=null;document.querySelector('#submit').disabled=false});
state().catch(e=>{document.querySelector('#issue').textContent=e.message;console.error(e)});
</script></body></html>`;
const server = createServer(async (req,res) => {
  requests.push({ method:req.method,path:req.url });
  try {
    if(req.url === '/favicon.ico'){res.writeHead(204);return res.end()}
    if(req.url === '/state'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(service.chromeQueue.list(identity.profileId)))}
    if(req.url === '/diagnostics'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({requests,errors,state:service.chromeQueue.list(identity.profileId)}))}
    if(req.url?.startsWith('/api/')){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));
      const action=req.url.slice(5);if(!['add','claim','checkpoint','resume','review','startSubmission','receipt'].includes(action))throw Error('unknown fixture action');
      const result=await service.chromeQueue[action](...(['add','claim'].includes(action)?[body,identity]:[body.id,body,identity]));
      res.setHeader('content-type','application/json');return res.end(JSON.stringify(result));
    }
    res.setHeader('content-type','text/html');res.end(html);
  } catch(e) { errors.push({path:req.url,status:e.status??500,message:e.message});res.writeHead(e.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message})); }
});
server.listen(Number(process.env.FIXTURE_PORT??4395),'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,fixtureCv:path.join(dir,'fixture-cv.txt'),isolated:true})));
