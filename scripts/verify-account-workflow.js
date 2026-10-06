#!/usr/bin/env node
// Isolated synthetic login UI. No employer account or real applicant state.
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { CredentialVault } from '../src/credential-vault.js';
import { ApplicationService } from '../src/service.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'account-browser-fixture-'));
const identity = { actorId: 'fixture-agent', profileId: 'synthetic-applicant' };
const scope = { sessionId: 'fixture-chat', origin: 'https://employer.example' };
const vault = new CredentialVault({ directory: dir, keys: { [identity.profileId]: randomBytes(32).toString('base64') } });
await vault.save(identity.profileId, scope.origin, { username: 'synthetic@example.test', password: 'fixture-login-only' });
const store = await new JsonStore(path.join(dir, 'state.json')).init();
const service = new ApplicationService({ store, credentialVault: vault, config: { defaultMode: 'full_time', execution: { workflow: 'chrome_session' }, modes: { full_time: {} } } });
const id = (await service.chromeQueue.add({ url: 'https://employer.example/jobs/fixture' }, identity)).application.id;
await service.chromeQueue.claim(scope, identity);
const requests = [], errors = [];
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Encrypted Account Workflow Fixture</title>
<style>body{font:18px system-ui;max-width:800px;margin:40px auto}label{display:block;margin:20px 0}button,input{font:inherit;padding:10px}#status{padding:18px;background:#eef5ff}#error{color:#b91c1c}</style></head><body>
<h1>Encrypted Account Workflow Fixture</h1><p>Synthetic account only. No real application is sent.</p>
<p id="status">Ready to check the encrypted vault</p><label>Account origin <input id="origin" value="https://employer.example"></label>
<button id="check">Check saved account</button><button id="load">Use saved login</button>
<form id="login"><label>Email <input id="email" autocomplete="off"></label><label>Password <input id="password" type="password" autocomplete="off"></label><button>Sign In</button></form>
<p id="error" role="alert"></p><p id="result"></p>
<script>
async function request(action){const r=await fetch('/account/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:document.querySelector('#origin').value})});const j=await r.json();if(!r.ok)throw Error(j.error);return j}
function bind(id,fn){document.querySelector('#'+id).onclick=async()=>{document.querySelector('#error').textContent='';try{await fn()}catch(e){document.querySelector('#error').textContent=e.message}}}
bind('check',async()=>{const j=await request('status');document.querySelector('#status').textContent=j.available?'Encrypted account found for this employer':'No saved account'});
bind('load',async()=>{const j=await request('access');document.querySelector('#email').value=j.username;document.querySelector('#password').value=j.password;document.querySelector('#status').textContent='Saved login loaded. Password stays out of application state.'});
document.querySelector('#login').onsubmit=async(e)=>{e.preventDefault();const r=await fetch('/fixture-login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:document.querySelector('#email').value,password:document.querySelector('#password').value})});const j=await r.json();document.querySelector('#password').value='';document.querySelector('#result').textContent=j.success?'Signed in as Synthetic Applicant. Application remains in progress.':'Login rejected';};
</script></body></html>`;
createServer(async (req, res) => {
  requests.push({ method: req.method, path: req.url });
  try {
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.url === '/diagnostics') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ requests, errors, queueStatus: service.chromeQueue.list(identity.profileId).current.status, secretInState: JSON.stringify(store.snapshot()).includes('fixture-login-only') })); }
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
      if (req.url === '/fixture-login') return res.end(JSON.stringify({ success: body.username === 'synthetic@example.test' && body.password === 'fixture-login-only' }));
      if (!['/account/status', '/account/access'].includes(req.url)) throw Error('unknown fixture route');
      return res.end(JSON.stringify(await service.accountAccess.run(req.url.split('/').at(-1), id, { ...scope, origin: body.origin }, identity)));
    }
    res.setHeader('content-type', 'text/html'); res.end(html);
  } catch (error) {
    const status = error.status ?? 500; errors.push({ path: req.url, status, message: error.message });
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: error.message }));
  }
}).listen(Number(process.env.FIXTURE_PORT ?? 4396), '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${process.env.FIXTURE_PORT ?? 4396}`, isolated: true })));
