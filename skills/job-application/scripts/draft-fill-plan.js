#!/usr/bin/env node
// Pure JSON planner. Does not open a browser, insert answers, upload, or submit.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const normalize = s => String(s ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
export function buildFillPlan({ draft, live }) {
  if (!draft?.readyToFill || !draft.correctedPacket) throw Error('Main session must review and correct the draft first');
  if (!live || !Number.isFinite(Date.parse(live.observedAt)) || !Array.isArray(live.fields) || live.fields.length > 200) throw Error('Current live form fields required');
  if (Date.parse(live.observedAt) > Date.now() || Date.now() - Date.parse(live.observedAt) > 10 * 60_000) throw Error('Current live form snapshot required');
  if (!/^https:\/\//.test(live.url)) throw Error('Live HTTPS form URL required');
  if (new URL(live.url).origin !== new URL(draft.officialPostingUrl).origin && live.destinationVerified !== true) throw Error('Verify the official application redirect before mapping fields');
  const answers = draft.correctedPacket.fields;
  const fields = [], uploads = [], unresolved = [], seen = new Set();
  for (const f of live.fields) {
    if (!f.key || !f.question || seen.has(f.key)) throw Error('Ambiguous live field key'); seen.add(f.key);
    if (typeof f.required !== 'boolean' || !['text', 'textarea', 'select', 'radio', 'checkbox', 'file'].includes(f.kind)) throw Error('Live requiredness and input kind required');
    const candidates = answers.filter(a => normalize(a.question) === normalize(f.question));
    const a = candidates.length === 1 ? candidates[0] : null;
    if (!a || a.status !== 'draft' || a.value === null || a.kind !== f.kind) {
      unresolved.push({ key: f.key, question: f.question, required: f.required === true, reason: candidates.length > 1 ? 'ambiguous draft question' : 'missing or mismatched draft' }); continue;
    }
    if (['text', 'textarea', 'select', 'radio', 'file'].includes(f.kind) && typeof a.value !== 'string'
      || f.kind === 'checkbox' && typeof a.value !== 'boolean') {
      unresolved.push({ key: f.key, question: f.question, required: f.required, reason: 'draft value type does not match live input' }); continue;
    }
    const locator = f.locator;
    if (!locator || !['role', 'label', 'placeholder', 'selector'].includes(locator.by) || typeof locator.value !== 'string'
      || !locator.value || locator.value.length > 2000 || locator.by === 'role' && !['textbox', 'combobox', 'radio', 'checkbox'].includes(locator.role)) throw Error('Observed input locator required');
    if (f.options && ![].concat(a.value).every(v => f.options.includes(v))) {
      unresolved.push({ key: f.key, question: f.question, required: f.required === true, reason: 'draft value absent from live options' }); continue;
    }
    if (f.kind === 'radio' && f.optionValue !== a.value || f.kind === 'checkbox' && typeof a.value !== 'boolean') {
      unresolved.push({ key: f.key, question: f.question, required: f.required, reason: 'verify the live radio target or checkbox value' }); continue;
    }
    if (f.kind === 'file') { uploads.push({ key: f.key, question: f.question, suggestedDocument: a.value, locator, verifyActualUpload: true }); continue; }
    const action = ['text', 'textarea'].includes(f.kind) ? 'fill' : f.kind === 'select' ? f.nativeSelect ? 'selectOption' : 'customSelect'
      : f.kind === 'radio' ? 'check' : 'setChecked';
    fields.push({ key: f.key, question: f.question, locator, action,
      value: action === 'selectOption' ? { label: a.value } : a.value, evidence: a.evidence });
  }
  return { schemaVersion: 1, applicationId: draft.applicationId, revision: draft.revision,
    liveUrl: live.url, observedAt: live.observedAt, fields, uploads, unresolved,
    missingInformation: draft.correctedPacket.missingInformation,
    readyForBatchFill: !unresolved.some(f => f.required), requiresLiveVerification: true,
    submissionAuthorized: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const filename = process.argv[2];
  if (!filename) throw Error('usage: draft-fill-plan.js /private/reviewed-draft-and-live-fields.json');
  process.stdout.write(JSON.stringify(buildFillPlan(JSON.parse(await readFile(filename, 'utf8')))) + '\n');
}
