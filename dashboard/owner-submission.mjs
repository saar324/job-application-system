// Owner-reported sends are distinct from agent attempts and browser-verified receipts.
// Date-only evidence is placed at UTC noon, which is always the same Sofia day.
export function explicitApplicationReceipt(text) {
 return typeof text === 'string' && /(?:\bwe\s+(?:have\s+)?received\s+(?:your|the)\s+application\b|\b(?:your\s+)?application\s+(?:has\s+been\s+|was\s+)?received\b|\bapplication\s+(?:successfully\s+)?submitted\b)/i.test(text)
  && !/\b(?:not received|not submitted|failed|unable to submit|could not submit|error)\b/i.test(text);
}
export function ownerSubmissionSentAt(application, now = new Date()) {
 const p = application.ownerSubmission;
 const linkedin = p?.channel === 'linkedin' && p.submissionActor === 'owner_linkedin'
  && p.evidence?.source === 'owner_provided_linkedin'
  && /^Application status\s+Application submitted(?:\s+now)?\s*$/i.test(p.evidence.successText ?? '');
 const browser = p?.channel === 'browser' && p.submissionActor === 'owner_browser'
  && p.evidence?.source === 'owner_provided_employer_confirmation'
  && explicitApplicationReceipt(p.evidence.successText) && p.jobUrl && p.finalUrl;
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
 if (browser) { try { const u = new URL(p.finalUrl); if (u.protocol !== 'https:' || u.username || u.password || u.origin !== new URL(p.jobUrl).origin) return null; } catch { return null; } }
 return date.toISOString();
}
