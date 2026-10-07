import { createHash } from 'node:crypto';
import { ClientError } from './service.js';

const hash = value => createHash('sha256').update(JSON.stringify({ value })).digest('hex');
const normalize = q => q.toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim();
const identity = f => hash([normalize(f.question), f.kind]);
const answered = f => f && f.value !== null && f.value !== '' && !['missing', 'needs_review', 'not_applicable'].includes(f.status);
const secret = /password|passwd|verification.?code|security.?code|one.?time.?code|\botp\b|secret|access.?token|cookie/i;
const legal = /legally|authorization|authorised|authorized|consent|agree|privacy|terms|permit|visa|sponsor|citizenship|clearance|debar/i;
const motivation = /what interests you|why (?:us|this|our|the)|why.*(?:work|join)|motivation|cover letter/i;
const causes = new Set(['missed_known_fact', 'field_unavailable', 'genuine_unknown', 'changed_options',
  'changed_facts', 'missing_motivation', 'weak_tailoring', 'mapping_error', 'needs_investigation']);
const actions = {
  missed_known_fact: 'Look up the exact current verified fact before leaving this question blank. Check scope and live options.',
  field_unavailable: 'Inspect the public form when available. Keep unobserved questions tentative; do not bypass an access gate.',
  genuine_unknown: 'Preserve the unknown. Check current facts and prior answers before asking the owner.',
  changed_options: 'Match current observed options. Do not force an old selection into a changed question.',
  changed_facts: 'Refresh draft context and recheck current evidence before writing.',
  missing_motivation: 'Draft a fresh role specific motivation answer even when optional, after checking employer writing rules.',
  weak_tailoring: 'Use concrete verified examples and current employer research. Do not reuse the corrected prose as a template.',
  mapping_error: 'Match the exact observed question and field type before preparing a loadable draft.',
  needs_investigation: 'Main review must identify the cause. A correction alone does not establish a reusable applicant fact.'
};

function currentValue(profile, binding) {
  return profile?.[binding.section]?.[binding.key];
}

// Only exact current facts become lookup hints. Lessons never carry answer values,
// grant consent, change facts, or loosen jurisdiction/contract scope.
function factBinding(field, profile) {
  if (!answered(field) || secret.test(field.question)) return null;
  const aliases = profile?.applicationAnswers ?? {};
  const exact = Object.keys(aliases).find(key => key === field.question);
  const match = exact ?? (!legal.test(field.question) && Object.keys(aliases).find(key => normalize(key) === normalize(field.question)));
  if (match && JSON.stringify(aliases[match]) === JSON.stringify(field.value)) {
    return { section: 'applicationAnswers', key: match, valueHash: hash(aliases[match]) };
  }
  if (legal.test(field.question)) return null;
  const basic = {
    'first name': ['contact', 'firstName'], 'last name': ['contact', 'lastName'],
    'email': ['contact', 'email'], 'email address': ['contact', 'email'],
    'phone': ['contact', 'phone'], 'phone number': ['contact', 'phone'],
    'location': ['contact', 'location'], 'current location': ['contact', 'location'],
    'website': ['links', 'portfolio'], 'linkedin profile': ['links', 'linkedin'], 'linkedin url': ['links', 'linkedin']
  }[normalize(field.question)];
  if (!basic) return null;
  const [section, key] = basic, value = profile?.[section]?.[key];
  return value !== undefined && JSON.stringify(value) === JSON.stringify(field.value)
    ? { section, key, valueHash: hash(value) } : null;
}

export function validateFeedbackNotes(notes = []) {
  if (!Array.isArray(notes) || notes.length > 200) throw new ClientError(400, 'bounded feedback reasons required');
  const seen = new Set();
  for (const n of notes) {
    if (!n || Object.keys(n).some(k => !['key', 'cause'].includes(k)) || typeof n.key !== 'string'
      || !n.key.trim() || n.key.length > 300 || !causes.has(n.cause) || seen.has(n.key) || secret.test(n.key)) {
      throw new ClientError(400, 'invalid draft feedback reason');
    }
    seen.add(n.key);
  }
  return notes;
}

export function analyzeDraftFeedback(original, corrected, profile, { notes = [], profileChanged = false } = {}) {
  validateFeedbackNotes(notes);
  const events = [];
  for (const field of corrected.fields) {
    const prior = original.fields.find(f => identity(f) === identity(field));
    const note = notes.find(n => n.key === field.key);
    const changed = !prior || JSON.stringify([prior.value, prior.status, prior.options]) !== JSON.stringify([field.value, field.status, field.options]);
    if (!changed && !note) continue;
    const binding = factBinding(field, profile);
    let cause = profileChanged ? 'changed_facts'
      : !answered(field) ? 'genuine_unknown'
        : !prior && !original.formObservation.complete ? 'field_unavailable'
          : JSON.stringify(prior?.options ?? []) !== JSON.stringify(field.options ?? []) && prior ? 'changed_options'
            : binding ? 'missed_known_fact'
              : motivation.test(field.question) ? (answered(prior) ? 'weak_tailoring' : 'missing_motivation')
                : 'needs_investigation';
    if (note) cause = note.cause;
    if (cause === 'missed_known_fact' && !binding) throw new ClientError(400, 'known fact feedback requires an exact current verified fact');
    events.push({ id: identity(field), key: field.key, question: field.question, kind: field.kind,
      cause, basis: note ? 'main_reason' : 'automatic_diff', action: actions[cause],
      ...(binding ? { binding } : {}), resolved: answered(field) });
  }
  if (notes.some(n => !corrected.fields.some(f => f.key === n.key))) throw new ClientError(400, 'feedback must reference a corrected field');
  return { schemaVersion: 1, events };
}

/** Read-only historical bootstrap plus persisted reports from subsequent reviews. */
export function learningContext(state, profileId, profile) {
  const applications = state.applications.filter(a => a.profileId === profileId && a.preparation);
  const reports = applications.flatMap(a => {
    const p = a.preparation;
    if (p.feedbackHistory?.length) return p.feedbackHistory.map(r => ({ ...r, applicationId: a.id }));
    if (!p.review) return [];
    return [{ ...analyzeDraftFeedback(p.packet, p.review.packet, profile,
      { profileChanged: p.fingerprint.profile !== p.review.fingerprint.profile }),
    applicationId: a.id, revision: p.review.revision, reviewedAt: p.review.reviewedAt, historical: true }];
  }).sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
  const grouped = new Map();
  for (const report of reports) for (const event of report.events) {
    const groupKey = `${event.id}:${event.cause}`;
    const g = grouped.get(groupKey) ?? { ...event, occurrences: 0, firstSeenAt: report.firstReviewedAt ?? report.reviewedAt, lastSeenAt: report.reviewedAt };
    g.occurrences++; g.lastSeenAt = report.reviewedAt;
    // Latest provenance wins; an outdated alias/value cannot survive a correction.
    if (event.binding) g.binding = event.binding;
    grouped.set(groupKey, g);
  }
  const latest = [...grouped.values()].sort((a,b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || b.occurrences - a.occurrences);
  const lessons = latest.slice(0, 30).map(g => {
    const usable = g.binding && hash(currentValue(profile, g.binding)) === g.binding.valueHash;
    const later = applications.filter(a => a.preparation.createdAt > g.firstSeenAt);
    let checked = 0, covered = 0, repeatedOmissions = 0, unobservable = 0;
    for (const a of later) {
      const packet = a.preparation.packet, field = packet.fields.find(f => identity(f) === g.id);
      if (!field && !packet.formObservation.complete) { unobservable++; continue; }
      if (g.cause !== 'missed_known_fact' || !usable) continue;
      checked++;
      if (answered(field) && hash(field.value) === g.binding.valueHash) covered++; else repeatedOmissions++;
    }
    const { binding, ...safe } = g;
    return { ...safe, eligible: g.cause !== 'missed_known_fact' || Boolean(usable),
      ...(usable ? { factLookup: { section: binding.section, key: binding.key } } : {}),
      measurement: { checked, covered, repeatedOmissions, unobservable } };
  });
  return { schemaVersion: 1, authority: 'draft_suggestions_only', reports: reports.length,
    totalCorrections: reports.reduce((n,r) => n + r.events.length, 0), totalLessons: latest.length,
    lessons, truncated: latest.length > 30 };
}
