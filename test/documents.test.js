import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,mkdir} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {readSessionResume} from '../src/documents.js';
test('session downloads only a current regular resume within its approved roots',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'job-cv-'));const approved=path.join(dir,'approved');await mkdir(approved);
 const resume=path.join(approved,'resume.pdf');await writeFile(resume,'Synthetic résumé bytes');
 const env={JOB_SERVER_ALLOWED_DOCUMENT_ROOTS:approved};
 const result=await readSessionResume({documents:{resume}},env);assert.equal(result.filename,'resume.pdf');assert.equal(result.bytes.toString(),'Synthetic résumé bytes');
 const outside=path.join(dir,'outside.pdf');await writeFile(outside,'Private unrelated file');await symlink(outside,path.join(approved,'linked.pdf'));
 await assert.rejects(readSessionResume({documents:{resume:path.join(approved,'linked.pdf')}},env),/invalid/);
 await assert.rejects(readSessionResume({documents:{resume:'relative.pdf'}},env),/absolute/);
 await assert.rejects(readSessionResume({documents:{resume}},{}),/roots/);
});
