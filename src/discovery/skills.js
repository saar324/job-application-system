const ALIASES = new Map([
  ["node.js", ["node.js", "nodejs", "node js"]],
  [".net", [".net", "dotnet", "asp.net"]],
  ["artificial intelligence", ["artificial intelligence", "ai"]],
  ["go", ["go", "golang"]],
  ["javascript", ["javascript", "java script"]],
  ["typescript", ["typescript", "type script"]],
  ["react", ["react", "react.js", "reactjs"]],
  ["vue", ["vue", "vue.js", "vuejs"]],
  ["c++", ["c++", "cpp"]],
  ["c#", ["c#", "c sharp"]]
]);

function escape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function canonicalSkill(value) {
  const normalized = String(value ?? "").normalize("NFKC").toLowerCase().trim();
  for (const [canonical, aliases] of ALIASES) {
    if (aliases.includes(normalized)) return canonical;
  }
  return normalized;
}

export function skillAliases(value) {
  const canonical = canonicalSkill(value);
  return ALIASES.get(canonical) ?? [canonical];
}

export function findSkillEvidence(text, skill) {
  const searchable = String(text ?? "").normalize("NFKC").toLowerCase();
  for (const alias of skillAliases(skill).sort((left, right) => right.length - left.length)) {
    const pattern = new RegExp(`(^|[^a-z0-9])(${escape(alias)})(?=$|[^a-z0-9])`, "i");
    const match = pattern.exec(searchable);
    if (!match) continue;
    const start = match.index + match[1].length;
    const before = searchable.slice(Math.max(0, start - 48), start);
    const after = searchable.slice(start + alias.length, start + alias.length + 48);
    if (/\b(?:no|not|without)\s+(?:\w+\s+){0,3}$/i.test(before)
      || /^\s+(?:experience\s+)?(?:is\s+)?not\s+required\b/i.test(after)) continue;
    return {
      canonical: canonicalSkill(skill), alias,
      evidence: searchable.slice(Math.max(0, start - 40), Math.min(searchable.length, start + alias.length + 80)).trim()
    };
  }
  return null;
}

export function matchSkills(text, skills = []) {
  return skills.map((skill) => ({ skill, match: findSkillEvidence(text, skill) }))
    .filter((item) => item.match)
    .map(({ skill, match }) => ({ skill, ...match }));
}
