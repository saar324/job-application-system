export const NO_RESPONSE_MS = 21 * 24 * 60 * 60 * 1000;
export const TERMINAL_EMPLOYER_STATUSES = new Set(['rejected', 'withdrawn', 'closed', 'hired']);
export const MEANINGFUL_REPLY_STATUSES = new Set([
  'under_review', 'awaiting_response', 'action_required', 'assessment', 'interview', 'offer',
  ...TERMINAL_EMPLOYER_STATUSES
]);
const waitingStatuses = new Set(['under_review', 'awaiting_response', 'application_received']);

export function inactivityDeadline(application) {
  if (application.status !== 'submitted' || application.receipt?.simulated === true) return null;
  const submittedAt = Date.parse(application.receipt?.submittedAt);
  if (!Number.isFinite(submittedAt)) return null;
  const employer = application.employerStatus;
  if (employer && !waitingStatuses.has(employer.status)) return null;
  const replyAt = Date.parse(application.lastEmployerFollowupAt ??
    (employer && employer.status !== 'application_received' ? employer.observedAt : undefined));
  return new Date(Math.max(submittedAt, Number.isFinite(replyAt) ? replyAt : submittedAt) + NO_RESPONSE_MS).toISOString();
}

export function trackingStatus(application) {
  if (TERMINAL_EMPLOYER_STATUSES.has(application.employerStatus?.status)) return application.employerStatus.status;
  if (application.lifecycle?.status === 'auto_closed') return 'auto_closed';
  if (application.status === 'submitted') return application.employerStatus?.status ?? 'submitted';
  return application.status;
}
