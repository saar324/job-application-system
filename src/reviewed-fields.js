import { createHash } from 'node:crypto';
import { LEGAL_ATTESTATION_FIELD } from './legal-fields.js';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = field => `${field.step ?? 0}:${field.key}`;
const equal = (a, b) => hash(a) === hash(b);
const PRIVACY = /privacy|gdpr|recruitment.*(?:retention|contact)|retain.*recruitment|candidate.*data|talent.?pool|(?:retain|stor(?:e|age|ing)|keep).*(?:application|personal|candidate).*(?:future|recruitment)|contact.*(?:job|career|recruitment)|(?:job|career).*contact/i;
const CONSENT = /^(yes|true|agree|i agree|consent|i consent)$/i;
const OBLIGATION = /terms|waiv|claims|arbitrat|contract|agreement|indemn|liability|release|obligation|marketing|promo|newsletter|advertising/i;
const EXTRA_LEGAL = /background|credit.?check|drug.?test|medical|health|biometric|criminal|export.?control|security.?clearance|visa|sponsor|citizen|immigra|(?:work|employment).{0,20}(?:eligib|permit|authori)|right.?to.?work|(?:information|answers?).{0,30}(?:accurac|truthful|correct|complete|true)/i;
const NON_RECRUITMENT_CONSENT = /(?:consent|agree|authori[sz]e|permit|allow|accept).{0,100}(?:background|credit.?check|drug.?test|medical|health|biometric|criminal|security.?screen)|(?:background|credit.?check|drug.?test|medical|biometric).{0,100}(?:consent|agree|authori[sz]e|permission)/i;
function consentScopes(value) {
  const text = String(value).replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase();
  return [
    [/privacy|gdpr|data protection|candidate data|personal data/, 'privacy'],
    [/retain|retention|stor(?:e|age|ing)|keep|talent.?pool/, 'retention'],
    [/contact|communication/, 'contact']
  ].filter(([pattern]) => pattern.test(text)).map(([, scope]) => scope);
}
export const requiresLegalReview = field => LEGAL_ATTESTATION_FIELD.test(`${field.label ?? ''} ${field.key ?? ''}`)
  || PRIVACY.test(`${field.label ?? ''} ${field.key ?? ''}`)
  || OBLIGATION.test(`${field.label ?? ''} ${field.key ?? ''}`)
  || NON_RECRUITMENT_CONSENT.test(`${field.label ?? ''} ${field.key ?? ''}`);
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
      if (OBLIGATION.test(text) || PRIVACY.test(text) || NON_RECRUITMENT_CONSENT.test(text)) throw new Error('commitment requires scoped consent');
      // Legal factual answers must use this exact saved question, not an unrelated Yes.
      if (legal && evidence.profileAnswerKey !== field.label) throw new Error('legal fact scope does not match');
    } else if (evidence.sourceKind === 'saved_recruitment_consent') {
      const answerKeys = evidence.profileAnswerKeys ?? [evidence.profileAnswerKey];
      if (!Array.isArray(answerKeys) || !answerKeys.length || answerKeys.length > 3
        || answerKeys.some(key => typeof key !== 'string' || !key.trim() || key.length > 3000)) throw new Error('recruitment consent scope does not match');
      const scopes = consentScopes(text);
      const approvedScopes = new Set(answerKeys.flatMap(key => consentScopes(key)));
      if (!legal || !PRIVACY.test(text) || !scopes.length
        || OBLIGATION.test(text) || EXTRA_LEGAL.test(text)
        || answerKeys.some(key => OBLIGATION.test(key) || EXTRA_LEGAL.test(key)
          || !consentScopes(key).length || !CONSENT.test(String(profileValue(profile, key))))
        || scopes.some(scope => !approvedScopes.has(scope))
        || !CONSENT.test(String(field.value))) throw new Error('recruitment consent scope does not match');
    } else if (evidence.sourceKind === 'reviewed_grounded_prose') {
      if (legal) {
        throw new Error('prose review not authorized');
      }
    } else if (evidence.sourceKind === 'current_owner_answer') {
      const resolutions = application.resolutions ?? [];
      const resolution = resolutions[evidence.resolutionIndex];
      const answer = resolution?.ownerAnswers?.find(answer => key(answer) === key(field));
      if (!Number.isInteger(evidence.resolutionIndex) || evidence.resolutionIndex < 0
        || !answer || answer.label !== field.label || !equal(answer.value, field.value)
        || answer.sourceReference !== evidence.sourceReference
        || resolutions.slice(evidence.resolutionIndex + 1).some(resolution => resolution.ownerAnswers?.some(answer => key(answer) === key(field)))) throw new Error('current owner answer scope does not match');
    } else throw new Error('unsupported field provenance');
    entries.push({ fieldKey: key(field), valueHash: hash(field.value), sourceKind: evidence.sourceKind,
      sourceReference: evidence.sourceReference, profileAnswerKey: evidence.profileAnswerKey,
      ...(evidence.sourceKind === 'current_owner_answer' ? { resolutionIndex: evidence.resolutionIndex } : {}),
      ...(evidence.profileAnswerKeys ? { profileAnswerKeys: evidence.profileAnswerKeys } : {}) });
  }
  return { schemaVersion: 1, profileId: identity.profileId, reviewerId: identity.actorId,
    authorizationSource: review.authorizationSource, previewFingerprint: fingerprint,
    opportunityId: opportunity.id, destination: preview.destination,
    company: preview.company, title: preview.title, fields: entries, reviewedAt: new Date().toISOString() };
}
