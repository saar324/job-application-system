// Reserve part of the model budget for jobs outside the deterministic top
// scores. A vocabulary mismatch can otherwise keep a suitable role unseen.
export function selectSemanticCandidateIndexes(preliminary, maximum, minimumScore) {
  if (!Number.isInteger(maximum) || maximum <= 0) return new Set();
  const groups = { qualifying: [], opportunistic: [], below: [] };
  for (const entry of preliminary) {
    if (entry.result.scoreDetails.hardExclusion) continue;
    const group = entry.result.scoreDetails.rolePriority === "opportunistic"
      ? "opportunistic" : entry.result.score < minimumScore ? "below" : "qualifying";
    groups[group].push(entry);
  }
  for (const entries of Object.values(groups)) entries.sort((a, b) => b.result.score - a.result.score);
  const chosen = new Set();
  const uncertainQuota = maximum >= 3 ? Math.max(1, Math.floor(maximum / 4)) : 0;
  const quotas = { qualifying: maximum - uncertainQuota * 2,
    opportunistic: uncertainQuota, below: uncertainQuota };
  for (const group of ["qualifying", "opportunistic", "below"]) {
    const entries = groups[group];
    const count = Math.min(entries.length, quotas[group], maximum - chosen.size);
    for (const entry of spread(entries, count)) chosen.add(entry.index);
  }
  const remaining = Object.values(groups).flat().filter((entry) => !chosen.has(entry.index))
    .sort((a, b) => b.result.score - a.result.score);
  for (const entry of remaining) {
    if (chosen.size >= maximum) break;
    chosen.add(entry.index);
  }
  return chosen;
}

function spread(entries, count) {
  if (!count) return [];
  if (count === 1) return entries.slice(0, 1);
  return Array.from({ length: count }, (_, index) =>
    entries[Math.floor(index * (entries.length - 1) / (count - 1))]);
}
