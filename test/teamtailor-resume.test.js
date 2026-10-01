import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {chromium} from 'playwright';
import {automateApplication,teamtailorResumeUploaded} from '../worker/automation.js';

// Public Teamtailor controller/DOM-derived synthetic fixture. No employer upload.
const preview=`<div data-controller="forms--inputs--upload-preview" data-forms--inputs--upload-preview-url-value="https://storage.example.test/current-resume.pdf"><div data-forms--inputs--upload-preview-target="name"><a data-forms--inputs--upload-preview-target="link">resume.pdf</a></div><input type="text" hidden name="candidate[resume_remote_url]" data-forms--inputs--upload-preview-target="urlInput" value="https://storage.example.test/current-resume.pdf"></div>`;
const html=`<form onsubmit="event.preventDefault();window.finalCount++;document.body.innerHTML='<h2>Your application was successfully submitted.</h2>'"><div id="upload_resume_field" data-controller="forms--inputs--upload"><label>Upload CV<input id="candidate_resume_remote_url" type="file" required></label><div id="previews"></div></div><label>Additional files<input id="candidate_file_remote_url" type="file"></label><button>Submit application</button></form><script>window.finalCount=0;document.querySelector('#candidate_resume_remote_url').onchange=e=>setTimeout(()=>{document.querySelector('#previews').innerHTML=${JSON.stringify(preview)};e.target.value='';e.target.disabled=true;},100);</script>`;

for(const mutation of ['none','url','filename','missing','extra','progress','prefilled']){
 test(`Teamtailor acknowledged remote resume ${mutation} preserves exact final guard`,async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'teamtailor-resume-'));const file=path.join(dir,'resume.pdf');await writeFile(file,'%PDF-1.4 synthetic fixture');
 const browser=await chromium.launch({headless:true});const context=await browser.newContext();const page=await context.newPage();t.after(async()=>{await browser.close();await rm(dir,{recursive:true,force:true});});
 await page.route('https://careers.example.test/**',r=>r.fulfill({contentType:'text/html',body:mutation==='prefilled'?html.replace('<div id="previews"></div>','<div id="previews">'+preview+'</div>'):html}));let commits=0;
 const result=await automateApplication({page,artifactsDirectory:dir,profile:{id:'synthetic',contact:{},links:{},documents:{resume:file},applicationAnswers:{}},application:{id:'synthetic-app',answers:{},standingPolicyVersion:1,claim:{attemptId:'synthetic-attempt'}},opportunity:{applyUrl:'https://careers.example.test/job'},authorizeFinal:async()=>{
 if(mutation!=='none')await page.evaluate(kind=>{const p=document.querySelector('[data-controller="forms--inputs--upload-preview"]');if(kind==='url')p.querySelector('input').value='https://storage.example.test/other.pdf';if(kind==='filename')p.querySelector('a').textContent='other.pdf';if(kind==='missing')p.remove();if(kind==='extra')p.parentElement.append(p.cloneNode(true));if(kind==='progress'){const d=document.createElement('div');d.setAttribute('data-forms--inputs--upload-preview-target','progress');p.append(d);}},mutation);
 return {decision:'permit',permit:'synthetic-permit'};},commitFinal:async()=>{commits++;return {committed:true};}});
 if(mutation==='none'){assert.equal(result.status,'submitted',JSON.stringify(result));assert.equal(commits,1);assert.equal(await page.evaluate(()=>window.finalCount),1);}else{assert.notEqual(result.status,'submitted');assert.equal(commits,0);assert.equal(await page.evaluate(()=>window.finalCount),0);}
 });
}

test('Teamtailor stale text and disabled remote input are not upload acknowledgements',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.setContent(`<div id="upload_resume_field" data-controller="forms--inputs--upload">${preview}</div>`);assert.equal(typeof await page.evaluate(teamtailorResumeUploaded,'resume.pdf'),'string');await page.locator('input').evaluate(e=>e.disabled=true);assert.equal(await page.evaluate(teamtailorResumeUploaded,'resume.pdf'),false);
});
