export function summarizeSourceHealth(sourceId, scans) {
  const rows = scans.filter((row) => row.sourceId === sourceId);
  const sum = (key) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const found = sum("found");
  const selected = sum("selected");
  const handledFiltered = sum("handledFiltered");
  const excluded = sum("excluded");
  const destinationPending = sum("destinationPending");
  const exclusionCounts = {
    hardExclusion: rows.reduce((sum, row) => sum + Number(row.exclusionCounts?.hardExclusion ?? 0), 0),
    belowScore: rows.reduce((sum, row) => sum + Number(row.exclusionCounts?.belowScore ?? 0), 0),
    opportunisticRequirements: rows.reduce((sum, row) => sum
      + Number(row.exclusionCounts?.opportunisticRequirements ?? 0), 0)
  };
  const challenge = rows.some((row) => row.challenge === true);
  const rateLimited = rows.some((row) => row.rateLimited === true);
  const timedOut = rows.some((row) => row.timedOut === true);
  const parseDrift = rows.some((row) => row.parseDrift === true);
  const manual = rows.some((row) => row.manual === true);
  const cooldownSkipped = rows.some((row) => row.cooldownSkipped === true);
  const cooldown = rows.findLast((row) => row.cooldownSkipped === true);
  const completed = rows.some((row) => row.completed !== false);
  const status = manual ? "manual" : cooldownSkipped ? "cooldown" : challenge ? "challenge" : rateLimited ? "rate_limited"
    : timedOut ? "timed_out"
    : parseDrift ? "parse_drift" : selected ? "yielding" : handledFiltered && (found === 0 || handledFiltered === found)
      ? "already_handled" : destinationPending && destinationPending >= found - excluded - handledFiltered
        ? "missing_destination" : excluded && excluded >= found - handledFiltered
          ? "ineligible" : !found && completed ? "zero_extractable" : completed ? "zero_accepted" : "in_progress";
  return { sourceId, status, completed, found, selected, handledFiltered, excluded, destinationPending,
    exclusionCounts, pagesVisited: sum("pagesVisited"), requestsMade: sum("requestsMade"),
    challenge, rateLimited, timedOut, parseDrift, cooldownSkipped,
    ...(cooldown ? { cooldownReason: cooldown.cooldownReason,
      cooldownUntil: cooldown.cooldownUntil } : {}) };
}
