export const SOURCE_COOLDOWN_MS = Object.freeze({
  challenge: 24 * 60 * 60_000,
  rate_limited: 6 * 60 * 60_000,
  timed_out: 30 * 60_000
});

// Audit events are durable across campaigns. A completed attempt replaces an
// older result; a cooldown skip is only coverage and must not extend the hold.
export function sourceCooldown(audit, profileId, sourceId, at = Date.now()) {
  return sourceCooldowns(audit, profileId, [sourceId], at)[sourceId] ?? null;
}

export function sourceCooldowns(audit, profileId, sourceIds, at = Date.now()) {
  const wanted = new Set(sourceIds);
  const latest = new Map();
  for (const event of audit) {
    const sourceId = event.details?.sourceId;
    if (event.profileId !== profileId || event.action !== "campaign.source_scanned"
      || !wanted.has(sourceId) || event.details.completed === false
      || event.details.cooldownSkipped === true) continue;
    if (!latest.has(sourceId) || event.at >= latest.get(sourceId).at) latest.set(sourceId, event);
  }
  return Object.fromEntries([...latest].flatMap(([sourceId, event]) => {
    const reason = event.details.challenge ? "challenge"
      : event.details.rateLimited ? "rate_limited"
        : event.details.timedOut ? "timed_out" : null;
    if (!reason) return [];
    const started = Date.parse(event.at);
    if (!Number.isFinite(started)) return [];
    const until = started + SOURCE_COOLDOWN_MS[reason];
    return until > at ? [[sourceId, { reason, until: new Date(until).toISOString(),
      observedAt: event.at }]] : [];
  }));
}
