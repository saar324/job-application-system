import assert from "node:assert/strict";
import test from "node:test";
import { createFieldReview, reviewedField } from "../src/reviewed-fields.js";

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

test("exact field evidence binds actual authenticated reviewer, value, policy, role and destination", () => {
  const f = fixture();
  const saved = createFieldReview(f);
  assert.equal(saved.reviewerId, "actual-agent");
  assert.equal(reviewedField(f.field, { ...f, review: saved }), true);
  for (const overrides of [
    { fingerprint: "b".repeat(64) }, { application: { ...f.application, profileId: "other" } },
    { opportunity: { id: "other-role" } }, { profile: { ...f.profile, standingSubmissionPolicy: { ...f.profile.standingSubmissionPolicy, version: 2 } } },
    { preview: { ...f.preview, destination: "https://example.test/other" } }
  ]) assert.equal(reviewedField(f.field, { ...f, review: saved, ...overrides }), false);
  assert.equal(reviewedField({ ...f.field, value: "6" }, { ...f, review: saved }), false);
  assert.throws(() => createFieldReview({ ...f, identity: { ...f.identity, profileId: "other" } }));
  assert.throws(() => createFieldReview({ ...f, profile: { ...f.profile, applicationAnswers: { experience: "4" } } }), /does not match/);
});

test("legal facts require the exact saved question rather than unrelated affirmative evidence", () => {
  const f = fixture({ step: 0, key: "work", label: "Are you authorized to work in Bulgaria?", value: "Yes" });
  f.profile.applicationAnswers.experience = "Yes";
  assert.throws(() => createFieldReview(f), /scope does not match/);
  f.profile.applicationAnswers[f.field.label] = "Yes";
  f.review.fields[0].profileAnswerKey = f.field.label;
  assert.equal(reviewedField(f.field, { ...f, review: createFieldReview(f) }), true);
});

test("recruitment consent covers affirmative privacy but not terms, liability or false answers", () => {
  const f = fixture({ step: 0, key: "privacy", label: "I consent to recruitment privacy retention", value: "Yes" });
  f.review.fields[0] = { step: 0, key: "privacy", sourceKind: "saved_recruitment_consent", sourceReference: "synthetic approved recruitment privacy", profileAnswerKey: "recruitmentPrivacy" };
  assert.equal(reviewedField(f.field, { ...f, review: createFieldReview(f) }), true);
  for (const label of ["I accept contractual terms and privacy", "I waive all claims", "I accept unlimited liability"]) {
    assert.throws(() => createFieldReview({ ...f, preview: { ...f.preview, filled: [{ ...f.field, label }] } }), /scope does not match/);
  }
  assert.throws(() => createFieldReview({ ...f, preview: { ...f.preview, filled: [{ ...f.field, value: "No" }] } }));
});

test("grounded prose needs standing class authority and never approves legal text", () => {
  const f = fixture({ step: 0, key: "motivation", label: "Why this role?", value: "A grounded example" });
  f.review.fields[0] = { step: 0, key: "motivation", sourceKind: "reviewed_grounded_prose", sourceReference: "synthetic verified project evidence" };
  assert.ok(createFieldReview(f));
  assert.throws(() => createFieldReview({ ...f, profile: { ...f.profile, standingSubmissionPolicy: { version: 1, answerClasses: ["profile_fact"] } } }), /not authorized/);
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
