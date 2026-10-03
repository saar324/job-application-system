import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
test('configuration has one execution workflow and strips obsolete private worker settings', async () => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'job-config-'));const file=path.join(dir,'config.json');
 await writeFile(file,JSON.stringify({execution:{adapter:'webhook',concurrency:4},modes:{full_time:{autoApply:true,submissionApproval:'always'}}}));
 const config=await loadConfig({JOB_SERVER_CONFIG:file});
 assert.equal(config.execution.workflow,'chrome_session');assert.equal(config.execution.adapter,undefined);
 assert.equal(config.execution.concurrency,undefined);assert.equal(config.modes.full_time.autoApply,undefined);
 await writeFile(file,JSON.stringify({execution:{workflow:'server_worker'}}));
 await assert.rejects(loadConfig({JOB_SERVER_CONFIG:file}),/workflow/);
});
test('public discovery starter preserves feed sources with passive Chrome execution',async()=>{
 const config=await loadConfig({JOB_SERVER_CONFIG:path.resolve('config/discovery.example.json')});
 assert.equal(config.execution.workflow,'chrome_session');
 for(const mode of ['full_time','freelance'])assert.deepEqual(config.modes[mode].sources,['remoteok','arbeitnow','jobicy','himalayas']);
});
