const CONFLICT_FIELDS = {
  full_time: ["compensation_conflict", "location_conflict"],
  freelance: ["rate_conflict", "scope_conflict"]
};

export function evaluatePolicy({ opportunity, mode, modeConfig, answers = {} }) {
  const reasons = [];
  const confirmations = [];
  const score = Number(opportunity.score ?? 0);
  if (opportunity.userRequested !== true && score < modeConfig.minimumScore) {
    reasons.push(`score ${score} is below ${modeConfig.minimumScore}`);
  }
  if (opportunity.scoreDetails?.hardExclusion) reasons.push(opportunity.scoreDetails.hardExclusion);

  const missing = (opportunity.requiredQuestions ?? []).filter(
    (question) => answers[question.key] === undefined || answers[question.key] === ""
  );
  if (missing.length) {
    confirmations.push({
      kind: "missing_answer",
      message: `Answers are required for: ${missing.map((item) => item.label).join(", ")}`,
      fields: missing.map((item) => item.key)
    });
  }
  for (const declaration of opportunity.legalAttestations ?? []) {
    if (answers[declaration.key] !== true) {
      confirmations.push({ kind: "legal_attestation", message: declaration.label, fields: [declaration.key] });
    }
  }
  for (const kind of CONFLICT_FIELDS[mode] ?? []) {
    if (opportunity.conflicts?.includes(kind)) {
      confirmations.push({ kind, message: `The opportunity has a ${kind.replaceAll("_", " ")}` });
    }
  }
  const allowed = new Set(modeConfig.requireConfirmationFor ?? []);
  return {
    eligible: reasons.length === 0,
    reasons,
    confirmations: confirmations.filter((item) => allowed.has(item.kind)),
    autoApply: modeConfig.autoApply === true
  };
}
