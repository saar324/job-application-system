import assert from "node:assert/strict";
import test from "node:test";
import { broadSoftwareRoleTitle, configuredTitlePriority,
  unrelatedOccupationTitle } from "../src/discovery/title-preferences.js";
import { scoreOpportunity } from "../src/discovery/scoring.js";

const role = (first, second) => `${first} ${second}`;
const profile = {
  skills: [],
  preferences: { fullTime: {
    jobTitles: [role("Full Stack", "Engineer"), role("Back-end", "Engineer"),
      role("Software", "Engineer"), role("Product", "Engineer"),
      role("Machine Learning", "Engineer"), role("Artificial Intelligence", "Engineer")],
    allowedLocations: ["Worldwide"], remoteOnly: true,
    opportunisticRoles: { enabled: true, minimumMatchedSkills: 5, minimumScore: 65 }
  } }
};

const softwareVariants = [
  role("Senior Fullstack", "Developer"), role("Senior Full Stack", "Engineer"),
  role("Backend", "Developer"), role("Back-end", "Engineer"),
  role("Software", "Developer"), role("Product", "Engineer"),
  role("AI/ML", "Engineer"), role("Machine Learning", "Developer"),
  role("Artificial Intelligence", "Engineer")
];

test("bounded software title variants retain configured priority and reach full scoring", () => {
  for (const title of softwareVariants) {
    assert.equal(broadSoftwareRoleTitle(title), true, title);
    assert.equal(unrelatedOccupationTitle(title), false, title);
    assert.equal(configuredTitlePriority(title, profile), "primary", title);
    const scored = scoreOpportunity({ title,
      description: "Build reliable services for a distributed product team",
      remote: true, location: "Worldwide", employmentType: "full_time" },
    profile, "full_time");
    assert.equal(scored.scoreDetails.hardExclusion, undefined, title);
    assert.equal(scored.scoreDetails.rolePriority, "primary", title);
    assert.ok(scored.score > 0, title);
  }
});

test("clearly unrelated occupations remain excluded despite incidental skill keywords", () => {
  const unrelated = ["Sales Engineer", "Account Executive", "Customer Success Engineer",
    "Product Manager", "Mechanical Engineer", "Nurse", "Chef"];
  for (const title of unrelated) {
    assert.equal(unrelatedOccupationTitle(title), true, title);
    const scored = scoreOpportunity({ title,
      description: "Our team builds reliable internal systems",
      remote: true, location: "Worldwide", employmentType: "full_time",
      compensation: { minimum: 100000, maximum: 150000, currency: "USD", period: "year" } },
    profile, "full_time");
    assert.equal(scored.score, 0, title);
    assert.ok(scored.scoreDetails.hardExclusions.includes("title identifies an unrelated occupation"), title);
  }
});

test("occupation exclusion does not absorb software roles or ambiguous adjacent titles", () => {
  assert.equal(unrelatedOccupationTitle(`${role("Software", "Engineer")}, Sales Platform`), false);
  assert.equal(unrelatedOccupationTitle(`${role("Customer Success", "Engineer")}, Software Platform`), true);
  assert.equal(unrelatedOccupationTitle("Technical Operations Specialist"), false);
  assert.equal(broadSoftwareRoleTitle("Technical Operations Specialist"), false);
});
