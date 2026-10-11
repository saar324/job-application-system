// Owner-reported sends are distinct from agent attempts and browser-verified receipts.
// Date-only evidence is placed at UTC noon, which is always the same Sofia day.
import { receiptDestinationMatches } from './receipt-destination.mjs';
export function explicitApplicationReceipt(text, { finalUrl, jobUrl, title, company } = {}) {
 if (typeof text !== 'string' || /\b(?:not received|not submitted|failed|unable to submit|could not submit|error)\b/i.test(text)) return false;
 if (/(?:\bwe\s+(?:have\s+)?received\s+(?:your|the)\s+application\b|\b(?:your\s+)?application\s+(?:has\s+been\s+|was\s+)?received\b|\byour\s+application\s+to\s+[^\r\n!?;:]{1,160}?\s+has\s+been\s+received\b|\bapplication\s+(?:successfully\s+)?submitted\b|\bthank\s+you\s+for\s+submitting\s+your\s+application\b)/i.test(text)) return true;
 try {
  const url = new URL(finalUrl);
  // The Hub emails explicitly name the completed application. Bind both names
  // to server-saved role metadata, never to caller-supplied confirmation context.
  if (url.protocol === 'https:' && url.hostname === 'thehub.io' && !url.port
   && !url.username && !url.password && /^\/jobs\/[a-f0-9]{24}\/?$/i.test(url.pathname)) {
   const source = new URL(jobUrl);
   if (source.origin !== url.origin || source.pathname.replace(/\/$/, '') !== url.pathname.replace(/\/$/, '')
    || source.username || source.password || typeof title !== 'string' || !title.trim()
    || typeof company !== 'string' || !company.trim()) return false;
   const normalize = value => value.trim().replace(/\s+/g, ' ');
   const expected = `Thank you for your application! You have applied for ${normalize(title)} at ${normalize(company)}`;
   return normalize(text) === expected || normalize(text) === expected + '.';
  }
  // Ashby can replace the form with a Success heading and this custom message.
  // Require the complete observed template and an official application URL;
  // the API and collector still bind that URL to the exact recorded role.
  return url.protocol === 'https:' && !url.username && !url.password
   && url.hostname === 'jobs.ashbyhq.com' && !url.port
   && /^\/[^/]+\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/application\/?$/i.test(url.pathname)
   && /^\s*Success\s+Thank you so much for your interest in joining [^\r\n!?;:]{1,160}? and considering us as part of your career journey!\s+Wishing you the best of luck in the process!\s*$/.test(text);
 } catch { return false; }
}
export function ownerSubmissionSentAt(application, now = new Date()) {
 const p = application.ownerSubmission;
 const linkedin = p?.channel === 'linkedin' && p.submissionActor === 'owner_linkedin'
  && p.evidence?.source === 'owner_provided_linkedin'
  && /^Application status\s+Application submitted(?:\s+now)?\s*$/i.test(p.evidence.successText ?? '');
 const browser = p?.channel === 'browser' && p.submissionActor === 'owner_browser'
  && p.evidence?.source === 'owner_provided_employer_confirmation'
  && explicitApplicationReceipt(p.evidence.successText, p) && p.jobUrl && p.finalUrl;
 if (p?.version !== 1 || (!linkedin && !browser)
  || p.identityMatchPending !== false
  || typeof p.recordKey !== 'string' || !p.recordKey.trim()
  || typeof p.evidence.reference !== 'string' || !p.evidence.reference.trim()
  || !/^[a-f0-9]{64}$/i.test(p.evidence.sha256 ?? '')
  || !/^\d{4}-\d{2}-\d{2}$/.test(p.submissionDate ?? '')
  || !Number.isFinite(Date.parse(p.observedAt)) || Date.parse(p.observedAt) > now.getTime()) return null;
 const date = new Date(`${p.submissionDate}T12:00:00Z`);
 if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== p.submissionDate) return null;
 const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(p.observedAt));
 if (p.submissionDate > parts) return null;
 if (p.jobUrl) { try { const u = new URL(p.jobUrl); if (u.protocol !== 'https:' || u.username || u.password) return null; } catch { return null; } }
 if (browser && !receiptDestinationMatches(p.jobUrl, p.finalUrl, p.destinationVerification, now)) return null;
 return date.toISOString();
}
