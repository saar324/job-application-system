import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitApplicationReceipt, ownerSubmissionSentAt } from '../dashboard/owner-submission.mjs';

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
