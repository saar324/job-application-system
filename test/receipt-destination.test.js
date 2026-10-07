import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyEmployerReceiptRedirect } from '../src/receipt-destination.js';
const source='https://jobs.lever.co/example/11111111-1111-4111-8111-111111111111/apply';
const final='https://employer.example/thanks';
const proof={sourceUrl:source,employerUrl:'https://employer.example/',linkText:'Example Home Page'};
for (const html of [
 '<script><a href="https://employer.example/">Example Home Page</a></script>',
 '<!-- <a href="https://employer.example/">Example Home Page</a> -->',
 '<template><a href="https://employer.example/">Example Home Page</a></template>',
 '<a href="https://unrelated.example/">Example Home Page</a>',
 '<a href="https://employer.example/">Unrelated link</a>'
]) test('redirect verification requires a visible labeled official company link: '+html.slice(0,35), async()=>{
 await assert.rejects(verifyEmployerReceiptRedirect(source,final,proof,async()=>new Response(html,{headers:{'content-type':'text/html'}})),/not the official ATS company link/);
});
test('receipt verification fails closed on source outage, redirect or excessive body',async()=>{
 for(const fetchImpl of [async()=>{throw Error('redirect')},async()=>new Response('',{status:503}),
  async()=>new Response('x'.repeat(2*1024*1024+1),{headers:{'content-type':'text/html'}})]) {
  await assert.rejects(verifyEmployerReceiptRedirect(source,final,proof,fetchImpl),/could not be verified/);
 }
});
