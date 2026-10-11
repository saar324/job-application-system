import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitApplicationReceipt, ownerSubmissionSentAt } from '../dashboard/owner-submission.mjs';

const ashbyUrl = 'https://jobs.ashbyhq.com/example/11111111-1111-4111-8111-111111111111/application';
const ashbySuccess = 'Success\nThank you so much for your interest in joining Example and considering us as part of your career journey! Wishing you the best of luck in the process!';

const hubUrl = 'https://thehub.io/jobs/111111111111111111111111';
const hubContext = { finalUrl: hubUrl, jobUrl: hubUrl, title: 'Senior Software Engineer', company: 'Example QMS' };
const hubSuccess = 'Thank you for your application! You have applied for Senior Software Engineer at Example QMS';

test('The Hub completed email requires the exact official job and trusted role and company names', () => {
  assert.equal(explicitApplicationReceipt(hubSuccess, hubContext), true);
  assert.equal(explicitApplicationReceipt(hubSuccess + '.', hubContext), true);
  assert.equal(explicitApplicationReceipt(hubSuccess.replace('! ', '!\n'), hubContext), true);
  for (const context of [{}, { finalUrl: hubUrl }, { ...hubContext, title: 'Other Engineer' },
    { ...hubContext, company: 'Other QMS' }, { ...hubContext, title: '' },
    { ...hubContext, jobUrl: hubUrl.replace(/1/g, '2') },
    { ...hubContext, jobUrl: hubUrl.replace('https:', 'http:') },
    { ...hubContext, finalUrl: hubUrl.replace('thehub.io', 'thehub.io.evil.example') },
    { ...hubContext, finalUrl: hubUrl.replace('https:', 'http:') },
    { ...hubContext, finalUrl: 'https://thehub.io/jobs' },
    { ...hubContext, finalUrl: hubUrl.replace('thehub.io', 'thehub.io:444') },
    { ...hubContext, finalUrl: hubUrl.replace('https://', 'https://example@') }]) {
    assert.equal(explicitApplicationReceipt(hubSuccess, context), false);
  }
  for (const text of ['Applied', 'Thank you for your application!',
    'You have applied for Senior Software Engineer at Example QMS',
    hubSuccess.replace('have applied', 'can apply'), hubSuccess + '\nClick Apply to finish.',
    hubSuccess + '\nUpload failed.', hubSuccess + '\nYour application was not submitted.']) {
    assert.equal(explicitApplicationReceipt(text, hubContext), false, text);
  }
});

test('dashboard recognizes persisted The Hub receipt context and rejects mismatched job or names', () => {
  const now = new Date('2026-10-08T10:00:00Z');
  const proof = { ...hubContext, version: 1, channel: 'browser', submissionActor: 'owner_browser',
    identityMatchPending: false, recordKey: 'fixture/thehub', submissionDate: '2026-10-08',
    observedAt: '2026-10-08T09:00:00Z', evidence: { source: 'owner_provided_employer_confirmation',
      reference: 'Exact-role confirmation', sha256: 'a'.repeat(64), successText: hubSuccess } };
  assert.equal(ownerSubmissionSentAt({ ownerSubmission: proof }, now), '2026-10-08T12:00:00.000Z');
  for (const change of [{ title: 'Other Engineer' }, { company: 'Other QMS' },
    { jobUrl: hubUrl.replace(/1/g, '2') }, { title: undefined },
    { evidence: { ...proof.evidence, successText: 'Applied' } }]) {
    assert.equal(ownerSubmissionSentAt({ ownerSubmission: { ...proof, ...change } }, now), null);
  }
});

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
