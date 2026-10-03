import test from 'node:test';import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHttpServer} from '../src/http.js';import {ApplicationService} from '../src/service.js';import {JsonStore} from '../src/store.js';
import {mkdtemp} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
test('MCP exposes passive profile-bound queue tools with no campaign or approval executor',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'job-mcp-'));const store=await new JsonStore(path.join(dir,'state.json')).init();
 const config={defaultMode:'full_time',execution:{workflow:'chrome_session'},modes:{full_time:{dailyApplicationCap:8}}};
 const profiles={get:async()=>({}),status:async()=>({readyToApply:false})};const service=new ApplicationService({store,config,profiles});
 const identity={profileId:'profile-one',actorId:'chat-one'};
 const server=createHttpServer({service,config,profiles,discovery:{describeSources:async()=>({sources:[]})},authenticate:req=>req.headers.authorization==='Bearer synthetic-token'?identity:null});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const client=new Client({name:'synthetic-test',version:'1.0'});t.after(()=>client.close());
 await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{authorization:'Bearer synthetic-token'}}}));
 const names=(await client.listTools()).tools.map(t=>t.name);assert.ok(names.includes('chrome_queue'));assert.ok(names.includes('queue_application'));assert.ok(!names.some(n=>/campaign|approve|confirm|callback/.test(n)));
 await client.callTool({name:'queue_application',arguments:{url:'https://employer.example/apply',profileId:'forged'}});
 const saved=store.snapshot().applications;assert.equal(saved.length,1);assert.equal(saved[0].profileId,identity.profileId);assert.equal(saved[0].status,'pending');
});
