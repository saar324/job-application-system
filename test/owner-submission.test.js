import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitApplicationReceipt, ownerSubmissionSentAt } from '../dashboard/owner-submission.mjs';

const ashbyUrl = 'https://jobs.ashbyhq.com/example/11111111-1111-4111-8111-111111111111/application';
const ashbySuccess = 'Success\nThank you so much for your interest in joining Example and considering us as part of your career journey! Wishing you the best of luck in the process!';

test('custom Ashby confirmation requires the success heading, complete template and official role URL', () => {
  assert.equal(explicitApplicationReceipt(ashbySuccess, { finalUrl: ashbyUrl }), true);
  const credentialUrl = new URL(ashbyUrl);
  credentialUrl.username = 'applicant';
  credentialUrl.password = 'synthetic';
  for (const finalUrl of [undefined, 'not a URL', 'https://employer.example/application',
    'https://jobs.ashbyhq.com/example', ashbyUrl.replace('https:', 'http:'),
    ashbyUrl.replace('jobs.ashbyhq.com', 'jobs.ashbyhq.com.evil.example'),
    credentialUrl.href]) {
    assert.equal(explicitApplicationReceipt(ashbySuccess, { finalUrl }), false, finalUrl);
  }
  for (const text of ['Success', ashbySuccess.replace('Success\n', ''),
    ashbySuccess.replace('Success\n', 'Review application\n'),
    ashbySuccess.replace('Success\n', 'Your application will show Success after Submit.\n'),
    ashbySuccess.replace('Wishing you the best of luck in the process!', ''),
    ashbySuccess + '\nError occurred.', ashbySuccess + '\nClick Submit to finish.']) {
    assert.equal(explicitApplicationReceipt(text, { finalUrl: ashbyUrl }), false, text);
  }
});

test('dashboard counts custom Ashby owner receipt once only with matching destination evidence', () => {
  const now = new Date('2026-10-08T10:00:00Z');
  const proof = { version: 1, channel: 'browser', submissionActor: 'owner_browser',
    identityMatchPending: false, recordKey: 'fixture/ashby-custom', submissionDate: '2026-10-08',
    observedAt: '2026-10-08T09:00:00Z', jobUrl: ashbyUrl, finalUrl: ashbyUrl,
    evidence: { source: 'owner_provided_employer_confirmation', reference: 'Exact-role live success page',
      sha256: 'a'.repeat(64), successText: ashbySuccess } };
  assert.equal(ownerSubmissionSentAt({ ownerSubmission: proof }, now), '2026-10-08T12:00:00.000Z');
  assert.equal(ownerSubmissionSentAt({ ownerSubmission: { ...proof,
    jobUrl: 'https://employer.example/jobs/1' } }, now), null);
  assert.equal(ownerSubmissionSentAt({ ownerSubmission: { ...proof,
    evidence: { ...proof.evidence, successText: 'Success' } } }, now), null);
});

test('named-employer confirmations require an explicit completed receipt', () => {
  for (const company of ['Example.ai', 'Example & Co.', 'Example (Europe)']) {
    assert.equal(explicitApplicationReceipt(`Your application to ${company} has been received.`), true);
  }
  for (const text of [
    'Thank you for applying to Example.ai.',
    'Your application to Example.ai will be received after you click Submit.',
    'Your application to Example.ai has not been received.',
    'Your application to Example.ai has been received. Error occurred.',
    'Your application to Example.ai has been received. Upload failed.',
    'Your application to Example.ai; upload has been received.',
    'Your application to Example.ai\nYour upload has been received.',
  ]) assert.equal(explicitApplicationReceipt(text), false, text);
});

test('dashboard sent dates accept YC receipts and keep failed evidence uncounted', () => {
  const now = new Date('2026-10-08T10:00:00Z');
  const url = 'https://www.ycombinator.com/companies/example-ai/jobs/ExampleId-full-stack-engineer';
  const proof = { version: 1, channel: 'browser', submissionActor: 'owner_browser',
    identityMatchPending: false, recordKey: 'fixture/yc-receipt', submissionDate: '2026-10-08',
    observedAt: '2026-10-08T09:00:00Z', jobUrl: url, finalUrl: url,
    evidence: { source: 'owner_provided_employer_confirmation', reference: 'Exact-role live receipt',
      sha256: 'a'.repeat(64), successText: 'Your application to Example.ai has been received.' } };
  assert.equal(ownerSubmissionSentAt({ ownerSubmission: proof }, now), '2026-10-08T12:00:00.000Z');
  for (const successText of ['Thank you for applying.', 'Your application to Example.ai has not been received.']) {
    assert.equal(ownerSubmissionSentAt({ ownerSubmission: { ...proof, evidence: { ...proof.evidence, successText } } }, now), null);
  }
});
