import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFillPlan } from '../skills/job-application/scripts/draft-fill-plan.js';
import { draftProfileFingerprint } from '../src/application-drafts.js';

const url = 'https://employer.example/jobs/engineer';
const evidence = [{ kind: 'profile_fact', reference: 'Verified synthetic applicant fact' }];
function fixture(kind = 'text', value = 'Corrected Fixture') {
  return {
    draft: { applicationId: 'synthetic-application', revision: 2, officialPostingUrl: url,
      readyToFill: true, correctedPacket: { fields: [{ key: 'draft-field', question: 'Full Name',
        kind, required: true, status: 'draft', value, evidence }], missingInformation: [] } },
    live: { url, observedAt: new Date().toISOString(), fields: [{ key: 'live-field', question: 'Full Name *',
      kind, required: true, locator: { by: 'label', value: 'Full Name *', exact: true } }] }
  };
}

test('one corrected packet maps actual labels and keeps every submission gate separate', () => {
  const input = fixture();
  const original = structuredClone(input);
  const plan = buildFillPlan(input);
  assert.deepEqual(input, original);
  assert.equal(plan.fields[0].value, 'Corrected Fixture');
  assert.equal(plan.fields[0].action, 'fill');
  assert.equal(plan.fields[0].locator.value, 'Full Name *');
  assert.deepEqual(plan.fields[0].evidence, evidence);
  assert.equal(plan.readyForBatchFill, true);
  assert.equal(plan.requiresLiveVerification, true);
  assert.equal(plan.submissionAuthorized, false);
  input.draft.readyToFill = false;
  assert.throws(() => buildFillPlan(input));
});

test('ambiguous questions and changed input kinds block required mapping', () => {
  const ambiguous = fixture();
  ambiguous.draft.correctedPacket.fields.push({ ...ambiguous.draft.correctedPacket.fields[0], key: 'other' });
  const ambiguity = buildFillPlan(ambiguous);
  assert.equal(ambiguity.fields.length, 0);
  assert.equal(ambiguity.readyForBatchFill, false);
  assert.match(ambiguity.unresolved[0].reason, /ambiguous/);
  const changed = fixture();
  changed.live.fields[0].kind = 'textarea';
  assert.equal(buildFillPlan(changed).readyForBatchFill, false);
  const duplicate = fixture();
  duplicate.live.fields.push({ ...duplicate.live.fields[0] });
  assert.throws(() => buildFillPlan(duplicate), /Ambiguous/);
});

test('select options use current labels and option drift prevents a batch fill', () => {
  const input = fixture('select', 'Bulgaria');
  Object.assign(input.live.fields[0], { options: ['Bulgaria', 'Other'], nativeSelect: true });
  const plan = buildFillPlan(input);
  assert.equal(plan.fields[0].action, 'selectOption');
  assert.deepEqual(plan.fields[0].value, { label: 'Bulgaria' });
  input.live.fields[0].options = ['United States', 'Canada'];
  const drift = buildFillPlan(input);
  assert.equal(drift.fields.length, 0);
  assert.equal(drift.readyForBatchFill, false);
  assert.match(drift.unresolved[0].reason, /absent/);
  input.live.fields[0].options = ['Bulgaria'];
  input.live.fields[0].nativeSelect = false;
  assert.equal(buildFillPlan(input).fields[0].action, 'customSelect');
});

test('radio requires its exact live target while checkboxes require a boolean', () => {
  const input = fixture('radio', 'No');
  Object.assign(input.live.fields[0], { options: ['Yes', 'No'], optionValue: 'Yes' });
  assert.equal(buildFillPlan(input).readyForBatchFill, false);
  input.live.fields[0].optionValue = 'No';
  assert.equal(buildFillPlan(input).fields[0].action, 'check');
  const checkbox = fixture('checkbox', 'Yes');
  assert.equal(buildFillPlan(checkbox).readyForBatchFill, false);
  checkbox.draft.correctedPacket.fields[0].value = true;
  assert.equal(buildFillPlan(checkbox).fields[0].action, 'setChecked');
});

test('file suggestions remain uploads to verify and non-input role locators are rejected', () => {
  const input = fixture('file', 'current_cv');
  const plan = buildFillPlan(input);
  assert.equal(plan.fields.length, 0);
  assert.equal(plan.uploads[0].suggestedDocument, 'current_cv');
  assert.equal(plan.uploads[0].verifyActualUpload, true);
  const unsafe = fixture();
  unsafe.live.fields[0].locator = { by: 'role', role: 'button', value: 'Submit' };
  assert.throws(() => buildFillPlan(unsafe), /locator/);
});

test('cross-origin form mappings require a verified destination', () => {
  const input = fixture();
  input.live.url = 'https://ats.example/application/engineer';
  assert.throws(() => buildFillPlan(input), /redirect/);
  input.live.destinationVerified = true;
  assert.equal(buildFillPlan(input).readyForBatchFill, true);
});

test('stale and future live snapshots cannot authorize batch mapping', () => {
  const input = fixture();
  input.live.observedAt = new Date(Date.now() - 11 * 60_000).toISOString();
  assert.throws(() => buildFillPlan(input));
  input.live.observedAt = new Date(Date.now() + 60_000).toISOString();
  assert.throws(() => buildFillPlan(input));
});

test('text arrays and unsupported select values are unresolved rather than invalid CUA actions', () => {
  for (const [kind, value] of [['text', ['One', 'Two']], ['textarea', true], ['select', ['Bulgaria']], ['select', 123]]) {
    const input = fixture(kind, value);
    input.live.fields[0].nativeSelect = true;
    const plan = buildFillPlan(input);
    assert.equal(plan.fields.length, 0, `${kind}: ${JSON.stringify(value)}`);
    assert.equal(plan.readyForBatchFill, false);
    assert.equal(plan.unresolved[0].required, true);
  }
});

test('draft fingerprint invalidates changes in every disclosed fact section', () => {
  const profile = { contact: { firstName: 'Fixture' }, links: {}, documents: {}, skills: ['Python'],
    applicationAnswers: {}, experience: [{ employer: 'Example', years: 2 }],
    workHistory: [{ company: 'Example', from: '2021' }], verifiedExamples: [], preferences: {} };
  const before = draftProfileFingerprint(profile);
  for (const section of Object.keys(profile)) {
    const changed = structuredClone(profile);
    changed[section] = { correction: 'New verified fact' };
    assert.notEqual(draftProfileFingerprint(changed), before, section);
  }
  assert.equal(draftProfileFingerprint(structuredClone(profile)), before);
});
