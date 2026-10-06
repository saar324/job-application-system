import { createHash, randomUUID } from 'node:crypto';
import { ClientError } from './service.js';
import { roleKeys, roleSimilarityKey } from './discovery/handled-roles.js';

const text = (v, label, limit = 1000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > limit) throw new ClientError(400, `${label} must be bounded text`);
  return v.trim();
};
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const secret = /password|passwd|verification.?code|one.?time.?code|\botp\b|secret|cookie|token/i;
function safeAnswers(raw = []) {
  if (!Array.isArray(raw) || raw.length > 100) throw new ClientError(400, 'historicalAnswers must be a bounded array');
  return raw.map(item => {
    if (!item || Object.keys(item).some(k => !['question', 'answer'].includes(k))) throw new ClientError(400, 'historical answers accept only question and answer');
    const question = text(item.question, 'question', 1000), answer = text(item.answer, 'answer', 5000);
    if (secret.test(question)) throw new ClientError(400, 'credentials must not enter application history');
    return { question, answer, verified: false, reusable: false };
  });
}
function publicUrl(raw) {
  if (raw === null || raw === undefined) return null;
  let u; try { u = new URL(raw); } catch { throw new ClientError(400, 'jobUrl must be public HTTPS'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.hostname === 'localhost' || u.hostname.endsWith('.local') || u.hostname.includes(':') || /^\d+(?:\.\d+){3}$/.test(u.hostname)) throw new ClientError(400, 'jobUrl must be public HTTPS');
  // Strip tracking parameters, but preserve employer posting IDs.
  u.hash = ''; for (const name of [...u.searchParams.keys()]) if (/^(utm_|trackingid$|refid$|ebp$|gh_src$|source$|src$)/i.test(name)) u.searchParams.delete(name);
  return u.toString();
}
export class ExternalSubmissions {
  constructor(service) { this.store = service.store; }
  async record(input, identity) {
    const allowed = ['recordKey', 'company', 'title', 'mode', 'jobUrl', 'submissionDate', 'observedAt', 'evidence', 'historicalAnswers'];
    if (Object.keys(input).some(k => !allowed.includes(k))) throw new ClientError(400, 'unsupported external submission field');
    const recordKey = text(input.recordKey, 'recordKey', 300), company = text(input.company, 'company', 250), title = text(input.title, 'title', 500);
    const mode = input.mode ?? 'full_time'; if (!['full_time', 'freelance'].includes(mode)) throw new ClientError(400, 'invalid mode');
    const jobUrl = publicUrl(input.jobUrl);
    if (typeof input.observedAt !== 'string' || !Number.isFinite(Date.parse(input.observedAt))) throw new ClientError(400, 'valid observedAt required');
    const observedAt = new Date(input.observedAt).toISOString();
    if (Date.parse(observedAt) > Date.now()) throw new ClientError(400, 'observedAt must not be in the future');
    const submissionDate = input.submissionDate;
    if (typeof submissionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(submissionDate) || !Number.isFinite(Date.parse(`${submissionDate}T12:00:00Z`)) || new Date(`${submissionDate}T12:00:00Z`).toISOString().slice(0, 10) !== submissionDate) throw new ClientError(400, 'valid submissionDate required');
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(observedAt));
    if (submissionDate > parts) throw new ClientError(400, 'submissionDate must not be after observation');
    const e = input.evidence;
    if (!e || Object.keys(e).some(k => !['source', 'successText', 'reference', 'sha256'].includes(k)) || e.source !== 'owner_provided_linkedin') throw new ClientError(400, 'owner LinkedIn evidence required');
    const successText = text(e.successText, 'successText', 2000), reference = text(e.reference, 'reference', 1000);
    if (!/^Application status\s+Application submitted(?:\s+now)?\s*$/i.test(successText) || !/^[a-f0-9]{64}$/i.test(e.sha256 ?? '')) throw new ClientError(400, 'explicit Application submitted confirmation and evidence hash required');
    const proof = { version: 1, channel: 'linkedin', submissionActor: 'owner_linkedin', submissionDate, observedAt, recordKey, jobUrl,
      evidence: { source: e.source, successText, reference, sha256: e.sha256.toLowerCase() }, historicalAnswers: safeAnswers(input.historicalAnswers) };
    const requestHash = hash({ company, title, mode, ...proof, observedAt: undefined });
    const baseRequestHash = hash({ company, title, mode, ...proof, jobUrl: undefined, observedAt: undefined });
    return this.store.mutate(state => {
      const prior = state.applications.find(a => a.profileId === identity.profileId && a.ownerSubmissionEvidence?.some(p => p.recordKey === recordKey));
      if (prior) {
        const p = prior.ownerSubmissionEvidence.find(p => p.recordKey === recordKey);
        if (p.requestHash === requestHash) return { duplicate: true, applicationId: p.canonicalApplicationId ?? prior.id, identityMatchPending: p.identityMatchPending === true };
        if (p.jobUrl || !jobUrl || p.baseRequestHash !== baseRequestHash) throw new ClientError(409, 'recordKey already has different evidence');
        // A later exact URL may resolve missing-link evidence, never rewrite its answer/date evidence.
        const keys = roleKeys({ applyUrl: jobUrl });
        const jobs = state.opportunities.filter(o => o.profileId === identity.profileId && [...roleKeys(o)].some(k => keys.has(k)));
        const existing = state.applications.find(a => a.profileId === identity.profileId && a.id !== prior.id && jobs.some(o => o.id === a.opportunityId) && (a.receipt?.submittedAt || a.ownerSubmission));
        const isImported = prior.executionMode === 'external_owner';
        // Evidence tentatively attached to an older employer receipt stays on that history unless the URL proves another role.
        if (!isImported) {
          const ownJob = state.opportunities.find(o => o.id === prior.opportunityId && o.profileId === identity.profileId);
          if (![...roleKeys(ownJob)].some(k => keys.has(k))) throw new ClientError(409, 'URL differs from tentative historical match; review identity before recording another send');
        }
        Object.assign(p, { jobUrl, identityMatchPending: false, requestHash });
        if (existing && isImported) {
          existing.ownerSubmissionEvidence ??= []; existing.ownerSubmissionEvidence.push({ ...p });
          if (!existing.ownerSubmission && !existing.receipt?.submittedAt) existing.ownerSubmission = { ...p };
          p.canonicalApplicationId = existing.id;
          delete prior.ownerSubmission; prior.status = 'external_duplicate';
        } else if (isImported) {
          const o = state.opportunities.find(o => o.id === prior.opportunityId && o.profileId === identity.profileId);
          if (jobs[0] && jobs[0].id !== o.id) prior.opportunityId = jobs[0].id;
          else Object.assign(o, { applyUrl: jobUrl, listingUrl: jobUrl });
          prior.ownerSubmission = p; prior.status = 'owner_reported_submitted';
        }
        state.audit.push({ id: randomUUID(), profileId: identity.profileId, actorId: identity.actorId, at: new Date().toISOString(), action: 'application.owner_linkedin_identity_resolved', subjectId: prior.id, details: { recordKey, canonicalApplicationId: existing?.id ?? prior.id } });
        return { duplicate: true, applicationId: existing?.id ?? prior.id, identityMatchPending: false };
      }
      const candidate = { company, title, applyUrl: jobUrl }, keys = jobUrl ? roleKeys(candidate) : new Set();
      const ownedJobs = state.opportunities.filter(o => o.profileId === identity.profileId);
      const strong = ownedJobs.filter(o => [...roleKeys(o)].some(k => keys.has(k)));
      const similar = jobUrl ? [] : ownedJobs.filter(o => roleSimilarityKey(o) === roleSimilarityKey(candidate));
      const candidates = strong.length ? strong : similar;
      const apps = state.applications.filter(a => a.profileId === identity.profileId && candidates.some(o => o.id === a.opportunityId));
      // Prefer existing sent history. Never replace its original send date or receipt.
      const matched = apps.find(a => a.receipt?.submittedAt && a.receipt.simulated !== true) ?? apps.find(a => a.ownerSubmission?.version === 1) ?? (strong.length ? apps[0] : undefined);
      const identityMatchPending = strong.length === 0 && similar.length > 0;
      proof.identityMatchPending = identityMatchPending;
      proof.requestHash = requestHash;
      proof.baseRequestHash = baseRequestHash;
      let application = matched;
      if (!application) {
        const opportunity = strong[0] ?? { id: randomUUID(), profileId: identity.profileId, company, title, source: 'linkedin', mode,
          ...(jobUrl ? { applyUrl: jobUrl, listingUrl: jobUrl } : {}), dedupKey: `external:${hash(recordKey)}`, createdAt: observedAt };
        if (!strong[0]) state.opportunities.push(opportunity);
        application = { id: randomUUID(), profileId: identity.profileId, opportunityId: opportunity.id, mode, executionMode: 'external_owner',
          status: identityMatchPending ? 'external_identity_pending' : 'owner_reported_submitted', createdAt: observedAt, updatedAt: observedAt, answers: {} };
        state.applications.push(application);
      }
      application.ownerSubmissionEvidence ??= []; application.ownerSubmissionEvidence.push(proof);
      if (!identityMatchPending && !application.receipt?.submittedAt && !application.ownerSubmission) application.ownerSubmission = proof;
      application.updatedAt = new Date().toISOString();
      state.audit.push({ id: randomUUID(), profileId: identity.profileId, actorId: identity.actorId, at: application.updatedAt,
        action: 'application.owner_linkedin_confirmation_recorded', subjectId: application.id, details: { recordKey, identityMatchPending, duplicate: !!matched } });
      return { duplicate: !!matched, applicationId: application.id, identityMatchPending };
    });
  }
}
