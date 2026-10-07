import { createHash } from 'node:crypto';
import { officialAtsIdentityFromUrl } from './discovery/official-ats.js';
import { plainText } from './discovery/text.js';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
async function boundedHtml(response) {
 if (Number(response.headers.get('content-length')) > MAX_HTML_BYTES) throw new Error('page too large');
 const reader = response.body.getReader(), chunks = []; let length = 0;
 try {
  for (;;) {
   const {done, value} = await reader.read(); if (done) break;
   length += value.length; if (length > MAX_HTML_BYTES) throw new Error('page too large');
   chunks.push(Buffer.from(value));
  }
 } finally { await reader.cancel(); }
 return Buffer.concat(chunks).toString('utf8');
}

// Fetch only the recorded official ATS URL, never a client supplied host or
// the employer confirmation URL. No cookies, credentials or redirects are used.
export async function verifyEmployerReceiptRedirect(destination, finalUrl, evidence, fetchImpl = fetch) {
 const source = new URL(destination), final = new URL(finalUrl);
 if (source.origin === final.origin) return undefined;
 if (!officialAtsIdentityFromUrl(source.href) || source.port
  || evidence?.sourceUrl !== source.href || typeof evidence.linkText !== 'string'
  || evidence.linkText.length > 300 || !/home\s*page|company\s*(?:website|site)|visit\s+(?:our\s+)?(?:website|site)/i.test(evidence.linkText)) {
  throw new Error('verified official ATS employer link required for receipt redirect');
 }
 let employer;
 try { employer = new URL(evidence.employerUrl); } catch { throw new Error('verified official ATS employer link required for receipt redirect'); }
 if (employer.protocol !== 'https:' || employer.username || employer.password || employer.port
  || employer.origin !== final.origin) throw new Error('receipt redirect employer origin does not match');
 let response, html;
 try {
  response = await fetchImpl(source.href, {redirect:'error', signal:AbortSignal.timeout(10_000),
   headers:{'user-agent':'job-application-system/0.2', accept:'text/html'}});
  if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') ?? '')
   || response.url && new URL(response.url).origin !== source.origin) throw new Error('official page unavailable');
  html = await boundedHtml(response);
 } catch { throw new Error('official ATS employer link could not be verified'); }
 // Ignore scripts, comments and templates. Match an actual labeled company link.
 const visible = html.replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
 const match = [...visible.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].some(([, attributes, content]) => {
  const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2];
  if (!href || plainText(content) !== evidence.linkText.trim()) return false;
  try {
   const link = new URL(plainText(href), source);
   if (link.username || link.password || link.port || !['http:', 'https:'].includes(link.protocol)) return false;
   // Some official ATS footers still link an HTTP company home page. Only
   // upgrade the same exact hostname to HTTPS; do not follow its redirect.
   link.protocol = 'https:';
   return link.href === employer.href;
  } catch { return false; }
 });
 if (!match) throw new Error('receipt redirect is not the official ATS company link');
 return {kind:'official_ats_employer_link', sourceUrl:source.href, finalUrl:final.href,
  employerOrigin:employer.origin, linkText:evidence.linkText.trim(),
  sourceContentHash:createHash('sha256').update(html).digest('hex'), verifiedAt:new Date().toISOString()};
}
