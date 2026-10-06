// Owner-reported LinkedIn sends are distinct from agent attempts and employer receipts.
// Date-only evidence is placed at UTC noon, which is always the same Sofia day.
export function ownerSubmissionSentAt(application, now = new Date()) {
 const p = application.ownerSubmission;
 if (p?.version !== 1 || p.channel !== 'linkedin' || p.submissionActor !== 'owner_linkedin'
  || p.identityMatchPending !== false || p.evidence?.source !== 'owner_provided_linkedin'
  || typeof p.recordKey !== 'string' || !p.recordKey.trim()
  || typeof p.evidence.reference !== 'string' || !p.evidence.reference.trim()
  || !/^[a-f0-9]{64}$/i.test(p.evidence.sha256 ?? '')
  || !/^Application status\s+Application submitted(?:\s+now)?\s*$/i.test(p.evidence.successText ?? '')
  || !/^\d{4}-\d{2}-\d{2}$/.test(p.submissionDate ?? '')
  || !Number.isFinite(Date.parse(p.observedAt)) || Date.parse(p.observedAt) > now.getTime()) return null;
 const date = new Date(`${p.submissionDate}T12:00:00Z`);
 if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== p.submissionDate) return null;
 const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(p.observedAt));
 if (p.submissionDate > parts) return null;
 if (p.jobUrl) { try { const u = new URL(p.jobUrl); if (u.protocol !== 'https:' || u.username || u.password) return null; } catch { return null; } }
 return date.toISOString();
}
