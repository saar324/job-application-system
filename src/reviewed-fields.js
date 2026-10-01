import { createHash } from 'node:crypto';
import { LEGAL_ATTESTATION_FIELD } from './standing-policy.js';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = field => `${field.step ?? 0}:${field.key}`;
const equal = (a, b) => hash(a) === hash(b);
const PRIVACY = /privacy|gdpr|recruitment.*(?:retention|contact)|retain.*recruitment|candidate.*data/i;
const CONSENT = /^(yes|true|agree|i agree|consent|i consent)$/i;
const OBLIGATION = /terms|waiv|claims|arbitrat|contract|agreement|indemn|liability|release|obligation|marketing|promo|newsletter|advertising/i;
export const requiresLegalReview = field => LEGAL_ATTESTATION_FIELD.test(`${field.label ?? ''} ${field.key ?? ''}`)
  || PRIVACY.test(`${field.label ?? ''} ${field.key ?? ''}`)
  || OBLIGATION.test(`${field.label ?? ''} ${field.key ?? ''}`);
function profileValue(profile, answerKey) {
  return Object.hasOwn(profile?.applicationAnswers ?? {}, answerKey ?? '')
    ? profile.applicationAnswers[answerKey] : undefined;
}
export function createFieldReview({ review, preview, fingerprint, identity, application, profile, opportunity }) {
  if (!identity?.actorId || identity.profileId !== application.profileId
    || !review || review.previewFingerprint !== fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint ?? '')
    || typeof review.authorizationSource !== 'string' || !review.authorizationSource.trim()
    || review.authorizationSource.length > 1000 || !Array.isArray(review.fields) || review.fields.length > 300
    || !preview || preview.unfilled?.some(f => f.required)) throw new Error('invalid exact field review');
  const fields = preview.filled ?? [];
  const entries = [];
  for (const evidence of review.fields) {
    const field = fields.find(f => key(f) === `${evidence.step ?? 0}:${evidence.key}`);
    if (!field || entries.some(e => e.fieldKey === key(field))
      || typeof evidence.sourceReference !== 'string' || !evidence.sourceReference.trim()
      || evidence.sourceReference.length > 1000) throw new Error('invalid field evidence');
    const text = `${field.label ?? ''} ${field.key ?? ''}`;
    const legal = requiresLegalReview(field);
    const saved = profileValue(profile, evidence.profileAnswerKey);
    if (evidence.sourceKind === 'saved_profile_fact') {
      if (saved === undefined || !equal(saved, field.value)) throw new Error('profile fact does not match');
      if (OBLIGATION.test(text) || PRIVACY.test(text)) throw new Error('commitment requires scoped consent');
      // Legal factual answers must use this exact saved question, not an unrelated Yes.
      if (legal && evidence.profileAnswerKey !== field.label) throw new Error('legal fact scope does not match');
    } else if (evidence.sourceKind === 'saved_recruitment_consent') {
      if (!legal || !PRIVACY.test(text) || !PRIVACY.test(evidence.profileAnswerKey ?? '')
        || OBLIGATION.test(text) || OBLIGATION.test(evidence.profileAnswerKey ?? '')
        || saved === undefined || !CONSENT.test(String(saved))
        || !CONSENT.test(String(field.value))) throw new Error('recruitment consent scope does not match');
    } else if (evidence.sourceKind === 'reviewed_grounded_prose') {
      if (legal || !profile?.standingSubmissionPolicy?.answerClasses?.includes('grounded_prose')) {
        throw new Error('prose review not authorized');
      }
    } else throw new Error('unsupported field provenance');
    entries.push({ fieldKey: key(field), valueHash: hash(field.value), sourceKind: evidence.sourceKind,
      sourceReference: evidence.sourceReference, profileAnswerKey: evidence.profileAnswerKey });
  }
  return { schemaVersion: 1, profileId: identity.profileId, reviewerId: identity.actorId,
    authorizationSource: review.authorizationSource, previewFingerprint: fingerprint,
    policyVersion: profile?.standingSubmissionPolicy?.version,
    opportunityId: opportunity.id, destination: preview.destination,
    company: preview.company, title: preview.title, fields: entries, reviewedAt: new Date().toISOString() };
}
export function reviewedField(field, { review, preview, fingerprint, application, profile, opportunity }) {
  if (!review || review.profileId !== application.profileId || review.opportunityId !== opportunity.id
    || review.policyVersion !== profile?.standingSubmissionPolicy?.version
    || review.previewFingerprint !== fingerprint || review.destination !== preview.destination
    || review.company !== preview.company || review.title !== preview.title) return false;
  const evidence = review.fields.find(e => e.fieldKey === key(field) && e.valueHash === hash(field.value));
  if (!evidence) return false;
  try {
    createFieldReview({ review: { previewFingerprint: fingerprint, authorizationSource: review.authorizationSource,
      fields: [{ ...evidence, step: field.step ?? 0, key: field.key }] }, preview: { ...preview, filled: [field] },
      fingerprint, identity: { actorId: review.reviewerId, profileId: review.profileId }, application, profile, opportunity });
    return true;
  } catch { return false; }
}
