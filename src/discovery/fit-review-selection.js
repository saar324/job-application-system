const midScore = (item) => item.score >= 45 && item.score < 60;
const lowScore = (item) => item.score >= 30 && item.score < 45;

function spreadSources(candidates, count, selected, perSource, sourceLimit) {
  const groups = new Map();
  for (const candidate of [...candidates].sort((left, right) => right.score - left.score)) {
    const source = String(candidate.source ?? "unknown");
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push(candidate);
  }
  while (selected.length < count && groups.size) {
    let added = false;
    for (const [source, queue] of groups) {
      if (selected.length >= count) break;
      while (queue.length && selected.includes(queue[0])) queue.shift();
      if (!queue.length || (perSource.get(source) ?? 0) >= sourceLimit) {
        groups.delete(source);
        continue;
      }
      selected.push(queue.shift());
      perSource.set(source, (perSource.get(source) ?? 0) + 1);
      added = true;
      if (!queue.length) groups.delete(source);
    }
    if (!added) break;
  }
}

// Review is advisory only. These candidates remain excluded from automatic
// selection and still need evidence-based fit and destination checks.
export function selectFitReviewCandidates(candidates, unverifiedSkillCandidates = [], maximum = 20) {
  if (!Number.isInteger(maximum) || maximum <= 0) return [];
  const hardReserve = Math.min(5, unverifiedSkillCandidates.length,
    Math.max(1, Math.floor(maximum / 4)));
  const regularLimit = maximum - hardReserve;
  const regular = candidates.filter((item) => !item.hardExclusion && item.score >= 30
    && (item.matchedSkillCount >= 2 || (item.matchedSkillCount >= 1
      && (item.titlePriority === "primary" || item.titlePriority === "secondary"))));
  const low = regular.filter(lowScore);
  const lowReserve = Math.min(3, low.length, Math.ceil(regularLimit * 0.2));
  const core = regular.filter((item) => item.score >= 60 && item.matchedSkillCount >= 3)
    .sort((left, right) => right.score - left.score);
  // Preserve the existing strong-review lane when its candidates fit in the
  // budget. Only an overfull old lane gives way to reserved lower-score slots.
  const chosen = core.slice(0, regularLimit - lowReserve);
  const perSource = new Map();
  spreadSources(regular.filter(midScore), regularLimit - lowReserve,
    chosen, perSource, 3);
  spreadSources(low, regularLimit, chosen, perSource, 3);
  spreadSources(regular, regularLimit, chosen, perSource, 3);
  const hard = [...unverifiedSkillCandidates]
    .sort((left, right) => right.matchedSkillCount - left.matchedSkillCount
      || right.score - left.score).slice(0, hardReserve);
  return [...chosen, ...hard].sort((left, right) => right.score - left.score);
}
