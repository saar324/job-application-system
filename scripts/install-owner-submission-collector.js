import { readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchOwnerSubmissionCollector } from '../dashboard/collector-patch.js';
const target=process.argv[2];
if(!target||!path.isAbsolute(target))throw new Error('Absolute collector directory required');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const snapshot=path.join(target,'snapshot.mjs');
const before=await readFile(snapshot,'utf8');
const after=patchOwnerSubmissionCollector(before);
await copyFile(path.join(root,'dashboard/owner-submission.mjs'),path.join(target,'owner-submission.mjs'));
if(before!==after){
 await writeFile(snapshot+'.before-owner-import',before,{mode:0o600,flag:'wx'});
 await writeFile(snapshot+'.tmp',after,{mode:0o644});await rename(snapshot+'.tmp',snapshot);
}
console.log(JSON.stringify({ok:true,changed:before!==after}));
