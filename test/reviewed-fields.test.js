import assert from "node:assert/strict";
import test from "node:test";
import { createFieldReview } from "../src/reviewed-fields.js";

function fixture(field = { step: 0, key: "experience", label: "Python experience", value: "5", source: "application answer" }) {
  const fingerprint = "a".repeat(64);
  const application = { id: "application", profileId: "person" };
  const profile = { applicationAnswers: { experience: "5", recruitmentPrivacy: true }, standingSubmissionPolicy: { version: 1, answerClasses: ["profile_fact", "grounded_prose"] } };
  const opportunity = { id: "role" };
  const preview = { destination: "https://example.test/apply", title: "Engineer", company: "Example", filled: [field], unfilled: [] };
  const identity = { actorId: "actual-agent", profileId: "person" };
  const review = { previewFingerprint: fingerprint, authorizationSource: "synthetic owner delegation", fields: [{ step: 0, key: field.key,
    sourceKind: "saved_profile_fact", sourceReference: "synthetic verified experience record", profileAnswerKey: "experience" }] };
  return { field, fingerprint, application, profile, opportunity, preview, identity, review };
}

test("exact field evidence binds actual authenticated reviewer, value, role and destination", () => {
  const f = fixture();
  const saved = createFieldReview(f);
  assert.equal(saved.reviewerId, "actual-agent");
  assert.equal(saved.opportunityId, f.opportunity.id);
  assert.equal(saved.destination, f.preview.destination);
  assert.throws(() => createFieldReview({ ...f, fingerprint: 'b'.repeat(64) }), /invalid exact/);
  assert.throws(() => createFieldReview({ ...f, preview: { ...f.preview, filled: [{ ...f.field, value: '6' }] } }), /does not match/);
  assert.throws(() => createFieldReview({ ...f, identity: { ...f.identity, profileId: "other" } }));
  assert.throws(() => createFieldReview({ ...f, profile: { ...f.profile, applicationAnswers: { experience: "4" } } }), /does not match/);
});

test("legal facts require the exact saved question rather than unrelated affirmative evidence", () => {
  const f = fixture({ step: 0, key: "work", label: "Are you authorized to work in Bulgaria?", value: "Yes" });
  f.profile.applicationAnswers.experience = "Yes";
  assert.throws(() => createFieldReview(f), /scope does not match/);
  f.profile.applicationAnswers[f.field.label] = "Yes";
  f.review.fields[0].profileAnswerKey = f.field.label;
  assert.ok(createFieldReview(f));
});

test("recruitment consent covers affirmative privacy but not terms, liability or false answers", () => {
  const f = fixture({ step: 0, key: "privacy", label: "I consent to recruitment privacy policy", value: "Yes" });
  f.review.fields[0] = { step: 0, key: "privacy", sourceKind: "saved_recruitment_consent", sourceReference: "synthetic approved recruitment privacy", profileAnswerKey: "recruitmentPrivacy" };
  assert.ok(createFieldReview(f));
  for (const label of ["I accept contractual terms and privacy", "I waive all claims", "I accept unlimited liability"]) {
    assert.throws(() => createFieldReview({ ...f, preview: { ...f.preview, filled: [{ ...f.field, label }] } }), /scope does not match/);
  }
  assert.throws(() => createFieldReview({ ...f, preview: { ...f.preview, filled: [{ ...f.field, value: "No" }] } }));
});

test("grounded prose follows the current delegation and never approves legal text", () => {
  const f = fixture({ step: 0, key: "motivation", label: "Why this role?", value: "A grounded example" });
  f.review.fields[0] = { step: 0, key: "motivation", sourceKind: "reviewed_grounded_prose", sourceReference: "synthetic verified project evidence" };
  assert.ok(createFieldReview(f));
  assert.ok(createFieldReview({ ...f, profile: { ...f.profile, standingSubmissionPolicy: undefined } }));
  assert.throws(() => createFieldReview({ ...f, preview: { ...f.preview, filled: [{ ...f.field, label: "I agree to contract terms" }] } }), /not authorized/);
});

test("ambiguous duplicate evidence and required unfilled content cannot produce a review", () => {
  const f = fixture();
  assert.throws(() => createFieldReview({ ...f, review: { ...f.review, fields: [...f.review.fields, ...f.review.fields] } }), /invalid field/);
  assert.throws(() => createFieldReview({ ...f, preview: { ...f.preview, unfilled: [{ key: "unknown", required: true }] } }), /invalid exact/);
  assert.throws(() => createFieldReview({ ...f, review: { ...f.review, authorizationSource: "" } }), /invalid exact/);
});

test("recruitment review rejects unrelated Yes evidence and mixed commitment keys", () => {
  const f = fixture({ step: 0, key: "privacy", label: "I consent to recruitment privacy retention", value: "Yes" });
  f.profile.applicationAnswers.unrelatedAnswer = "Yes";
  f.review.fields[0] = { step: 0, key: "privacy", sourceKind: "saved_recruitment_consent", sourceReference: "synthetic privacy evidence", profileAnswerKey: "unrelatedAnswer" };
  assert.throws(() => createFieldReview(f), /scope does not match/);
  f.review.fields[0].profileAnswerKey = "recruitmentPrivacy";
  const mixed = { ...f.field, key: "terms_waiver", label: "Privacy consent and indemnification" };
  assert.throws(() => createFieldReview({ ...f, preview: { ...f.preview, filled: [mixed] }, review: { ...f.review,
    fields: [{ ...f.review.fields[0], key: mixed.key }] } }), /scope does not match/);
});

test("saved exact-label Yes cannot turn an old contract answer into current legal authority", () => {
  const f = fixture({ step: 0, key: "contract", label: "I accept unlimited liability under this contract", value: "Yes" });
  f.profile.applicationAnswers[f.field.label] = "Yes";
  f.review.fields[0].profileAnswerKey = f.field.label;
  assert.throws(() => createFieldReview(f), /scope|legal|contract|commitment/i);
});

test("scoped recruitment contact is reusable while marketing consent remains separate", () => {
  const f = fixture({ step: 0, key: "recruitment_contact", label: "I consent to recruitment contact", value: "Yes" });
  f.profile.applicationAnswers.recruitmentContact = true;
  f.review.fields[0] = { step: 0, key: f.field.key, sourceKind: "saved_recruitment_consent", sourceReference: "synthetic approved recruitment contact", profileAnswerKey: "recruitmentContact" };
  assert.ok(createFieldReview(f));
  assert.throws(() => createFieldReview({ ...f, preview: { ...f.preview, filled: [{ ...f.field, label: "I consent to recruitment contact and marketing" }] } }), /scope/);
});

for (const phrase of ["promotions", "newsletters"]) {
  test(`recruitment consent cannot cover mixed ${phrase}`, () => {
    const f = fixture({ step: 0, key: "recruitment_contact", label: `I consent to recruitment contact and ${phrase}`, value: "Yes" });
    f.profile.applicationAnswers.recruitmentContact = true;
    f.review.fields[0] = { step: 0, key: f.field.key, sourceKind: "saved_recruitment_consent", sourceReference: "synthetic recruitment contact permission", profileAnswerKey: "recruitmentContact" };
    assert.throws(() => createFieldReview(f), /scope/);
  });
}

test("an exact saved binding agreement answer is not factual legal authority", () => {
  const f = fixture({ step: 0, key: "agreement", label: "I agree to the binding agreement", value: "Yes" });
  f.profile.applicationAnswers[f.field.label] = "Yes";
  f.review.fields[0].profileAnswerKey = f.field.label;
  assert.throws(() => createFieldReview(f), /scope|legal|agreement|commitment/i);
});

test("saved privacy approval does not cover a background check or recruitment contact", () => {
  for (const label of ["I accept recruitment privacy and authorize a background check",
    "I accept privacy and consent to future recruitment contact"]) {
    const f = fixture({ key: "privacy", label, value: true });
    f.review.fields[0] = { key: "privacy", sourceKind: "saved_recruitment_consent",
      sourceReference: "Owner approved the recruitment privacy policy only", profileAnswerKey: "recruitmentPrivacy" };
    assert.throws(() => createFieldReview(f), /scope/);
  }
});

test("a previous background-check consent is not a reusable factual answer", () => {
  const f = fixture({ key: 'background', label: 'I authorize a background check', value: 'Yes' });
  f.profile.applicationAnswers[f.field.label] = 'Yes';
  f.review.fields[0].profileAnswerKey = f.field.label;
  assert.throws(() => createFieldReview(f), /commitment/);
});

test("combined recruitment consent needs saved approval for every requested scope", () => {
  const f = fixture({ key: 'privacy', label: 'I consent to recruitment privacy, data retention and future recruitment contact', value: true });
  f.profile.applicationAnswers.job_application_future_recruitment_data_retention_consent_approved = true;
  f.profile.applicationAnswers.job_application_future_recruitment_contact_consent_approved = true;
  f.review.fields[0] = { key: 'privacy', sourceKind: 'saved_recruitment_consent', sourceReference: 'Owner approved all three recruitment scopes',
    profileAnswerKeys: ['recruitmentPrivacy', 'job_application_future_recruitment_data_retention_consent_approved', 'job_application_future_recruitment_contact_consent_approved'] };
  const saved = createFieldReview(f);
  assert.deepEqual(saved.fields[0].profileAnswerKeys, f.review.fields[0].profileAnswerKeys);
  f.profile.applicationAnswers.job_application_future_recruitment_contact_consent_approved = false;
  assert.throws(() => createFieldReview(f), /scope/);
});

test("saved retention and contact consent covers equivalent recruitment wording", () => {
  for (const [label, answerKey] of [
    ['I agree to storing my application for future job opportunities', 'job_application_future_recruitment_data_retention_consent_approved'],
    ['I consent to being contacted about future job opportunities', 'job_application_future_recruitment_contact_consent_approved']
  ]) {
    const f = fixture({ key: 'future_opportunities', label, value: true });
    f.profile.applicationAnswers[answerKey] = true;
    f.review.fields[0] = { key: f.field.key, sourceKind: 'saved_recruitment_consent', sourceReference: 'Verified owner recruitment consent', profileAnswerKey: answerKey };
    assert.ok(createFieldReview(f));
  }
});
