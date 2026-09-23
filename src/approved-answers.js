import { createHash } from "node:crypto";

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function answerEvidenceFingerprint(profile) {
  return fingerprint({ contact: profile?.contact ?? null, links: profile?.links ?? null,
    skills: profile?.skills ?? null, preferences: profile?.preferences ?? null,
    applicationAnswers: profile?.applicationAnswers ?? null, documents: profile?.documents ?? null });
}

export function approvedAnswerFingerprint(answer) {
  return fingerprint({ question: answer.question, value: answer.value, scope: answer.scope,
    approvedAt: answer.approvedAt, reviewAfter: answer.reviewAfter,
    evidenceFingerprint: answer.evidenceFingerprint, ownerActorId: answer.ownerActorId });
}

export function draftContextFingerprint(profile, opportunity, evidencePacket, answers) {
  return fingerprint({ profile: answerEvidenceFingerprint(profile),
    company: opportunity?.company, title: opportunity?.title,
    description: opportunity?.description, applyUrl: opportunity?.applyUrl,
    evidencePacket, answers: answers ?? {} });
}

export function reusableApprovedAnswer(answer, profile, opportunity, question, at = Date.now()) {
  if (!answer || !answer.ownerActorId || !answer.evidenceFingerprint || !answer.contentFingerprint
    || approvedAnswerFingerprint(answer) !== answer.contentFingerprint
    || answer.evidenceFingerprint !== answerEvidenceFingerprint(profile)
    || !answer.scope?.employer || !answer.reviewAfter || Date.parse(answer.reviewAfter) <= at
    || Date.parse(answer.approvedAt) > at) return false;
  const normalize = (value) => String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return normalize(answer.question) === normalize(question)
    && normalize(answer.scope.employer) === normalize(opportunity?.company)
    && (!answer.scope.role || normalize(answer.scope.role) === normalize(opportunity?.title));
}
