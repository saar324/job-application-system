export const draftPacket = (url = 'https://employer.example/new') => ({
  schemaVersion: 1, officialPostingUrl: url,
  formObservation: { url, observedAt: new Date().toISOString(), complete: false, access: 'not_inspected' },
  fields: [{ key: 'name', question: 'First Name', kind: 'text', required: null, value: 'Fixture', status: 'draft',
    evidence: [{ kind: 'profile_fact', reference: 'Verified synthetic profile' }] }],
  coverLetter: { text: '', aiPolicy: 'not_checked', evidence: [] },
  missingInformation: [], research: [], notes: 'Generic suggestion. Main must inspect actual form.'
});
