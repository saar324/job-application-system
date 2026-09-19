import assert from "node:assert/strict";
import test from "node:test";
import { parseJobPostingJsonLd, normalizeOpportunity } from "../src/discovery/normalization.js";
import { findSkillEvidence } from "../src/discovery/skills.js";
import { scoreOpportunity } from "../src/discovery/scoring.js";

test("JobPosting JSON-LD normalizes location, employment, and compensation with provenance", () => {
  const result = parseJobPostingJsonLd(`<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "JobPosting", title: "Senior Engineer",
    hiringOrganization: { name: "Example" }, description: "Build systems",
    url: "https://example.test/jobs/1", jobLocationType: "TELECOMMUTE",
    applicantLocationRequirements: { "@type": "Country", name: "Bulgaria" },
    employmentType: "FULL_TIME", baseSalary: { currency: "EUR", value: { minValue: 50000, maxValue: 70000, unitText: "YEAR" } }
  })}</script>`);
  assert.equal(result.title, "Senior Engineer");
  assert.equal(result.remote, true);
  assert.equal(result.employmentType, "full_time");
  assert.equal(result.compensation.maximum, 70000);
  assert.equal(result.provenance.title.source, "schema.org");
});

test("opportunity normalization retains explicit uncertainty instead of inventing facts", () => {
  const result = normalizeOpportunity({ title: "Engineer", company: "Example", description: "A role" });
  assert.ok(result.uncertainties.includes("location_unknown"));
  assert.ok(result.uncertainties.includes("employment_type_unknown"));
  assert.equal(result.remote, false);
});

test("short skills use token boundaries and reject negated requirements", () => {
  assert.equal(findSkillEvidence("Maintain Google email systems", "AI"), null);
  assert.equal(findSkillEvidence("Maintain Google email systems", "Go"), null);
  assert.equal(findSkillEvidence("No Go experience required", "Go"), null);
  assert.equal(findSkillEvidence("Experience with Golang services", "Go").canonical, "go");
});

test("semantic ranking cannot override a deterministic hard exclusion", () => {
  const result = scoreOpportunity({ title: "Engineer", description: "Node.js", remote: false,
    semanticScore: 1, postedAt: new Date().toISOString() }, {
    skills: ["Node.js"], preferences: { fullTime: { jobTitles: ["Engineer"], remoteOnly: true } }
  }, "full_time");
  assert.equal(result.score, 0);
  assert.match(result.scoreDetails.hardExclusion, /remote/);
});
