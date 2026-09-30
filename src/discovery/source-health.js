export function summarizeSourceHealth(sourceId, scans) {
  const rows = scans.filter((row) => row.sourceId === sourceId);
  const sum = (key) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const measuredSum = (key) => rows.some((row) => Number.isFinite(row[key])) ? sum(key) : null;
  const found = sum("found");
  const selected = sum("selected");
  const handledFiltered = sum("handledFiltered");
  const excluded = sum("excluded");
  const destinationPending = sum("destinationPending");
  const submissionUnsupported = sum("submissionUnsupported");
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
  const partialReasons = [...new Set(rows.flatMap((row) => row.partialReasons ?? []))];
  const terminal = rows.findLast((row) => row.completed !== false);
  const exhausted = rows.findLast((row) => row.completed !== false)?.exhausted === true;
  const hasError = rows.some((row) => row.sourceFailure === true);
  const status = manual ? "manual" : cooldownSkipped ? "cooldown" : challenge ? "challenge" : rateLimited ? "rate_limited"
    : timedOut ? "timed_out"
    : parseDrift || partialReasons.includes("invalid_next_page") ? "parse_drift"
      : partialReasons.length ? "partial_cap"
      : hasError ? "partial_error" : selected ? "yielding" : handledFiltered && (found === 0 || handledFiltered === found)
      ? "already_handled" : destinationPending && destinationPending >= found - excluded - handledFiltered
        ? "missing_destination" : submissionUnsupported ? "submission_unsupported" : excluded && excluded >= found - handledFiltered
          ? "ineligible" : !found && completed ? "zero_extractable" : completed ? "zero_accepted" : "in_progress";
  return { sourceId, status, completed, found, selected, handledFiltered, excluded, destinationPending,
    submissionUnsupported,
    exclusionCounts, pagesVisited: measuredSum("pagesVisited"), requestsMade: sum("requestsMade"),
    elapsedMs: measuredSum("elapsedMs"),
    rawRowsObserved: measuredSum("rawRowsObserved"),
    adapterPrescreenRejected: measuredSum("adapterPrescreenRejected"),
    dedupFiltered: measuredSum("dedupFiltered"), scored: measuredSum("scored"),
    qualifying: sum("qualifying"),
    discardedObservedCandidates: sum("discardedObservedCandidates"),
    challenge, rateLimited, timedOut, parseDrift, cooldownSkipped, exhausted, partialReasons,
    stopReason: terminal?.stopReason ?? null,
    discardReason: terminal?.discardReason ?? null,
    queryStats: rows.flatMap((row) => row.queryStats ?? []),
    skippedTerms: [...new Set(rows.flatMap((row) => row.skippedTerms ?? []))],
    coverageBlocked: rows.some((row) => row.coverageBlocked === true),
    ...(cooldown ? { cooldownReason: cooldown.cooldownReason,
      cooldownUntil: cooldown.cooldownUntil } : {}) };
}
