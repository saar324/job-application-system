import { explicitApplicationReceipt } from '../dashboard/owner-submission.mjs';

const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const mailbox = value => typeof value === 'string' && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) ? value.toLowerCase() : null;
const includesPhrase = (subject, phrase) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'u').test(subject);
const atsMailDomains = ['ycombinator.com', 'ashbyhq.com', 'greenhouse.io', 'lever.co', 'teamtailor.com'];

// This is manually inspected email evidence, not an independent mailbox fetch.
// Bind it to previously saved exact-role status, verified contact and the original
// attempt. A mailbox URL is evidence provenance, never an employer redirect.
export function verifyEmailReceipt(receipt, application, opportunity, profile, action, now = new Date()) {
  const proof = receipt.emailEvidence, status = application.employerStatus;
  const reject = () => { throw new Error('verified exact-role employer email evidence required'); };
  if (receipt.evidenceType !== 'employer_confirmation_email' || !proof || !action || !status
    || status.status !== 'application_received' || !status.sourceId || !/email/i.test(status.source ?? '')
    || proof.messageReference !== status.sourceId || proof.subject !== status.subject
    || normalize(proof.company) !== normalize(opportunity.company) || !normalize(proof.company)
    || normalize(proof.title) !== normalize(opportunity.title) || !normalize(proof.title)
    || !explicitApplicationReceipt(receipt.successText)) reject();
  const subject = normalize(proof.subject);
  if (!includesPhrase(subject, normalize(opportunity.company)) || !includesPhrase(subject, normalize(opportunity.title))) reject();
  const sender = mailbox(proof.sender), recipient = mailbox(proof.recipient);
  const contacts = [profile?.contact?.email, profile?.contact?.secondaryEmail, profile?.contact?.icloudEmail].map(mailbox).filter(Boolean);
  if (!sender || !recipient || !contacts.includes(recipient) || status.sender && mailbox(status.sender) !== sender) reject();
  const source = new URL(action.destination), final = new URL(receipt.finalUrl);
  const senderDomain = sender.split('@')[1];
  const directEmployer = source.hostname.replace(/^www\./, '') === senderDomain;
  const linkedAts = atsMailDomains.includes(senderDomain)
    && (source.hostname === senderDomain || source.hostname.endsWith('.' + senderDomain));
  if ((!directEmployer && !linkedAts) || source.port || source.protocol !== 'https:'
    || source.username || source.password || final.port
    || !['mail.proton.me', 'mail.google.com', 'www.icloud.com', 'outlook.live.com', 'outlook.office.com'].includes(final.hostname)) reject();
  const received = Date.parse(proof.receivedAt), observed = Date.parse(receipt.observedAt), started = Date.parse(action.startedAt);
  if (![received, observed, started].every(Number.isFinite) || received !== Date.parse(status.observedAt)
    || received < started || received > observed || observed > now.getTime() + 60_000) reject();
  return { kind: 'verified_employer_email', messageReference: proof.messageReference,
    destination: action.destination, attemptId: action.attemptId, receivedAt: new Date(received).toISOString() };
}
