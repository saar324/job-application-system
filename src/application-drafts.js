import { createHash } from 'node:crypto';
import { ClientError } from './service.js';
import { answerEvidenceFingerprint } from './approved-answers.js';
import { officialAtsIdentityFromUrl } from './discovery/official-ats.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (status, message) => { throw new ClientError(status, message); };
const secret = /password|passwd|verification.?code|security.?code|one.?time.?code|\botp\b|secret|access.?token|cookie/i;
const text = (v, name, max = 3000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail(400, `${name} must be bounded text`);
};
const keys = (o, allowed, name) => {
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some(k => !allowed.includes(k))) fail(400, `invalid ${name} structure`);
};
const url = v => {
  text(v, 'public draft URL', 2000);
  let u; try { u = new URL(v); } catch { fail(400, 'public HTTPS draft URL required'); }
  if (u.protocol !== 'https:' || u.username || u.password || /localhost|\.local$|:/.test(u.hostname)
    || /^\d+(?:\.\d+){3}$/.test(u.hostname) || [...u.searchParams.keys()].some(k => /token|code|auth|session|signature/i.test(k))) fail(400, 'public HTTPS draft URL required');
};
function evidence(items) {
  if (!Array.isArray(items) || items.length > 20) fail(400, 'bounded draft evidence required');
  for (const e of items) {
    keys(e, ['kind', 'reference', 'profileAnswerKey'], 'draft evidence');
    if (!['profile_fact', 'owner_fact', 'resume', 'job_posting', 'derived'].includes(e.kind)) fail(400, 'draft evidence kind required');
    text(e.reference, 'draft evidence reference', 2000);
    if (e.profileAnswerKey !== undefined) text(e.profileAnswerKey, 'profile answer key');
  }
}

/** Suggestions only. No operational state, consent, or submission authority can enter this schema. */
export function validateDraft(packet) {
  keys(packet, ['schemaVersion', 'officialPostingUrl', 'formObservation', 'fields', 'coverLetter', 'missingInformation', 'research', 'notes'], 'draft packet');
  if (packet.schemaVersion !== 1) fail(400, 'draft schemaVersion must be 1');
  if (JSON.stringify(packet).length > 100_000) fail(400, 'draft packet too large');
  url(packet.officialPostingUrl);
  keys(packet.formObservation, ['url', 'observedAt', 'complete', 'access'], 'form observation');
  url(packet.formObservation.url);
  if (!Number.isFinite(Date.parse(packet.formObservation.observedAt)) || typeof packet.formObservation.complete !== 'boolean'
    || !['public', 'not_accessible', 'not_inspected'].includes(packet.formObservation.access)) fail(400, 'actual form observation required');
  if (packet.formObservation.complete && packet.formObservation.access !== 'public') fail(400, 'inaccessible form cannot be complete');
  if (!Array.isArray(packet.fields) || packet.fields.length > 200) fail(400, 'bounded draft fields required');
  const seen = new Set();
  for (const f of packet.fields) {
    keys(f, ['key', 'question', 'kind', 'required', 'options', 'value', 'status', 'evidence', 'notes'], 'draft field');
    text(f.key, 'draft field key', 300); text(f.question, 'draft question');
    if (seen.has(f.key)) fail(400, 'duplicate draft field key'); seen.add(f.key);
    if (secret.test(f.key) || secret.test(f.question)) fail(400, 'credentials must not enter drafts');
    if (!['text', 'textarea', 'select', 'radio', 'checkbox', 'file'].includes(f.kind)
      || ![true, false, null].includes(f.required) || !['draft', 'missing', 'needs_review', 'not_applicable'].includes(f.status)) fail(400, 'draft field metadata required');
    if (f.value !== null && !['string', 'boolean', 'number'].includes(typeof f.value)
      && (!Array.isArray(f.value) || f.value.length > 100 || f.value.some(v => !['string', 'boolean', 'number'].includes(typeof v)))) fail(400, 'draft values must be scalar');
    if (JSON.stringify(f.value)?.length > 20000 || f.value === undefined || typeof f.value === 'number' && !Number.isFinite(f.value)) fail(400, 'bounded draft value required');
    if (f.status === 'missing' && f.value !== null) fail(400, 'missing draft values must be null');
    if (f.options !== undefined && (!Array.isArray(f.options) || f.options.length > 500 || f.options.some(v => typeof v !== 'string' || v.length > 1000))) fail(400, 'invalid draft options');
    evidence(f.evidence);
    if (f.status === 'draft' && f.evidence.length === 0) fail(400, 'draft answers need provenance');
    if (f.notes !== undefined) text(f.notes, 'draft notes');
  }
  keys(packet.coverLetter, ['text', 'aiPolicy', 'evidence'], 'draft cover letter');
  if (!['no_prohibition_found', 'prohibited', 'not_checked'].includes(packet.coverLetter.aiPolicy)
    || typeof packet.coverLetter.text !== 'string' || packet.coverLetter.text.length > 20000) fail(400, 'draft cover letter metadata required');
  if (packet.coverLetter.text && packet.coverLetter.aiPolicy !== 'no_prohibition_found') fail(400, 'check employer writing policy before drafting');
  evidence(packet.coverLetter.evidence);
  if (packet.coverLetter.text && !packet.coverLetter.evidence.length) fail(400, 'cover letter needs provenance');
  if (!Array.isArray(packet.missingInformation) || packet.missingInformation.length > 200) fail(400, 'draft missing information list required');
  for (const m of packet.missingInformation) { keys(m, ['question', 'reason'], 'missing information'); text(m.question, 'missing question'); text(m.reason, 'missing reason'); }
  if (!Array.isArray(packet.research) || packet.research.length > 30) fail(400, 'bounded draft research required');
  for (const r of packet.research) { keys(r, ['url', 'fact'], 'research'); url(r.url); text(r.fact, 'research fact'); }
  if (packet.notes !== undefined) text(packet.notes, 'packet notes', 5000);
  return structuredClone(packet);
}

export const postingFingerprint = o => hash({ company: o?.company, title: o?.title, description: o?.description,
  applyUrl: o?.applyUrl, applicationQuestions: o?.applicationQuestions, remote: o?.remote, location: o?.location,
  employmentType: o?.employmentType, compensation: o?.compensation, postingStatus: o?.postingStatus, validThrough: o?.validThrough });
export const draftProfileFingerprint = profile => hash({ answers: answerEvidenceFingerprint(profile),
  experience: profile?.experience ?? null, workHistory: profile?.workHistory ?? null });
export function draftFingerprint(profile, opportunity) {
  return { profile: draftProfileFingerprint(profile), posting: postingFingerprint(opportunity) };
}
export function saveDraft(item, opportunity, packet, profile, writer, at) {
  const validated = validateDraft(packet);
  if (new URL(validated.officialPostingUrl).href !== new URL(opportunity.applyUrl).href) {
    const submitted = officialAtsIdentityFromUrl(validated.officialPostingUrl), canonical = officialAtsIdentityFromUrl(opportunity.applyUrl);
    if (!submitted || !canonical || submitted.key !== canonical.key) fail(400, 'draft posting must match queued role');
    validated.officialPostingUrl = opportunity.applyUrl;
  }
  item.preparation = { schemaVersion: 1, status: 'unreviewed', revision: (item.preparation?.revision ?? 0) + 1,
    packet: validated, fingerprint: draftFingerprint(profile, opportunity), writer, createdAt: at };
  delete item.preparationLease;
}

export class ApplicationDrafts {
  constructor(service) { this.service = service; this.store = service.store; }
  async context(identity) {
    const profile = await this.service.profiles.get(identity.profileId);
    return { profileFingerprint: draftProfileFingerprint(profile), facts: Object.fromEntries(
      ['contact', 'links', 'documents', 'skills', 'applicationAnswers', 'experience', 'workHistory', 'verifiedExamples', 'preferences']
        .filter(k => profile?.[k] !== undefined).map(k => [k, profile[k]])) };
  }
  #item(state, id, identity) {
    const item = state.applications.find(a => a.id === id && a.profileId === identity.profileId && a.executionMode === 'chrome_session');
    if (!item) fail(404, 'queued application not found');
    return item;
  }
  async load(id, identity) {
    const state = this.store.snapshot(), item = this.#item(state, id, identity);
    const opportunity = state.opportunities.find(o => o.id === item.opportunityId && o.profileId === identity.profileId);
    const profile = await this.service.profiles.get(identity.profileId), current = draftFingerprint(profile, opportunity);
    const draft = item.preparation;
    const stale = { profileChanged: Boolean(draft && draft.fingerprint.profile !== current.profile),
      postingChanged: Boolean(draft && draft.fingerprint.posting !== current.posting) };
    const reviewedCurrent = draft?.review?.revision === draft?.revision
      && draft?.review?.fingerprint.profile === current.profile && draft?.review?.fingerprint.posting === current.posting
      && Date.now() - Date.parse(draft.review.reviewedAt) <= 10 * 60_000;
    return { applicationId: id, company: opportunity.company, title: opportunity.title, officialPostingUrl: opportunity.applyUrl,
      revision: draft?.revision ?? 0, fingerprint: current, status: !draft ? 'missing' : stale.profileChanged || stale.postingChanged ? 'stale' : 'unreviewed',
      packet: draft?.packet ?? null, correctedPacket: reviewedCurrent ? draft.review.packet : null,
      readyToFill: Boolean(reviewedCurrent && draft.review.readyToFill), stale,
      facts: Object.fromEntries(['contact', 'links', 'documents', 'skills', 'applicationAnswers', 'experience', 'workHistory', 'verifiedExamples', 'preferences']
        .filter(k => profile?.[k] !== undefined).map(k => [k, profile[k]])) };
  }
  async review(id, input, identity) {
    const packet = validateDraft(input.packet), profile = await this.service.profiles.get(identity.profileId);
    return this.store.mutate(state => {
      const item = this.#item(state, id, identity);
      if (item.sessionId !== input.sessionId || item.sessionActorId !== identity.actorId || item.status !== 'in_progress' || item.finalAction) fail(409, 'only current main session may correct draft before filling');
      const opportunity = state.opportunities.find(o => o.id === item.opportunityId && o.profileId === identity.profileId);
      const current = draftFingerprint(profile, opportunity);
      if (!item.preparation || input.revision !== item.preparation.revision || input.fingerprint?.profile !== current.profile
        || input.fingerprint?.posting !== current.posting) fail(409, 'reload draft: revision, profile or posting changed');
      if (new URL(packet.officialPostingUrl).href !== new URL(opportunity.applyUrl).href) fail(400, 'draft posting must match queued role');
      const readyToFill = packet.formObservation.complete && packet.formObservation.access === 'public'
        && Date.now() - Date.parse(packet.formObservation.observedAt) <= 10 * 60_000
        && Date.parse(packet.formObservation.observedAt) <= Date.now()
        && packet.missingInformation.length === 0 && !packet.fields.some(f => f.required && ['missing', 'needs_review'].includes(f.status));
      item.preparation.review = { packet, revision: input.revision, fingerprint: current, readyToFill,
        reviewerId: identity.actorId, sessionId: input.sessionId, reviewedAt: new Date().toISOString() };
      return { applicationId: id, revision: input.revision, readyToFill, status: 'corrected_draft', liveReviewRequired: true };
    });
  }
}
