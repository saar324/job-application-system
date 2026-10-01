// Recruiter metadata never changes submission state or queues a browser action.
export function normalizeRecruiterOutreach(input) {
  const text = (value, name, max, required = false) => {
    if (value == null && !required) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`Invalid ${name}`);
    return value.trim();
  };
  const r = input?.recruiter;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw Error('recruiter is required');
  const recruiter = { fullName: text(r.fullName, 'fullName', 200, true), source: text(r.source, 'source', 1000, true) };
  for (const field of ['email', 'phone', 'linkedinUrl', 'sourceUrl']) {
    const value = text(r[field], field, field.endsWith('Url') ? 2000 : 300);
    if (value) recruiter[field] = value;
  }
  if (recruiter.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recruiter.email)) throw Error('Invalid email');
  for (const field of ['linkedinUrl', 'sourceUrl']) if (recruiter[field]) {
    let url; try { url = new URL(recruiter[field]); } catch { throw Error(`Invalid ${field}`); }
    if (url.protocol !== 'https:' || url.username || url.password) throw Error(`Invalid ${field}`);
    if (field === 'linkedinUrl' && !/(^|\.)linkedin\.com$/.test(url.hostname)) throw Error('Invalid linkedinUrl');
  }
  const observedAt = r.observedAt ?? new Date().toISOString();
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) throw Error('Invalid observedAt');
  recruiter.observedAt = new Date(observedAt).toISOString();
  let outreach;
  if (input.outreach != null) {
    const draft = text(input.outreach.draft, 'draft', 1000, true);
    if (/[-;\u2013\u2014]/.test(draft)) throw Error('Draft must not contain hyphens, semicolons, or dashes');
    const context = text(input.outreach.context, 'context', 1500, true);
    const status = input.outreach.status ?? 'draft';
    if (!['draft', 'sent_by_owner'].includes(status)) throw Error('Invalid outreach status');
    outreach = { channel: 'linkedin', draft, context, status };
  }
  return { recruiter, outreach };
}
