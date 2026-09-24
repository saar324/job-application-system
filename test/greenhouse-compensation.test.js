import assert from "node:assert/strict";
import test from "node:test";
import { greenhouseAnnualSalary } from "../src/discovery/greenhouse-compensation.js";
import { greenhouse } from "../src/discovery/sources/greenhouse.js";
import { fetchVerifiedOfficialAtsRole } from "../src/discovery/official-ats.js";
import { scoreOpportunity } from "../src/discovery/scoring.js";

const applyUrl = "https://job-boards.greenhouse.io/example/jobs/12345";
const row = (content) => ({ id: 12345, title: "Senior Engineer", absolute_url: applyUrl,
  location: { name: "Remote, Bulgaria" }, content });

test("Greenhouse feed and fresh official detail expose the same explicit annual USD range", async () => {
  const content = "<p>TypeScript Node.js</p><p>Annual salary: $80k–$105k USD</p>";
  const feed = await greenhouse.search({ sourceConfig: { boards: [{ token: "example",
    company: "Example" }] }, fetchImpl: async () => new Response(JSON.stringify({ jobs: [row(content)] })) });
  const official = await fetchVerifiedOfficialAtsRole(applyUrl, {}, async () =>
    new Response(JSON.stringify(row(content))));
  const expected = { minimum: 80_000, maximum: 105_000, currency: "USD", period: "year" };
  assert.deepEqual(feed[0].compensation, expected);
  assert.deepEqual(official.compensation, expected);
});

test("Greenhouse salary parser ignores non-salary money and ambiguous periods", () => {
  assert.equal(greenhouseAnnualSalary("Travel budget: $80k–$105k USD annually."), undefined);
  assert.equal(greenhouseAnnualSalary("Bonus: $80k–$105k USD annually."), undefined);
  assert.equal(greenhouseAnnualSalary("Salary: $80k–$105k USD."), undefined);
  assert.equal(greenhouseAnnualSalary("Salary: $80k–$105k USD monthly."), undefined);
  assert.equal(greenhouseAnnualSalary("Annual salary: $80k–$105k USD monthly."), undefined);
  assert.equal(greenhouseAnnualSalary("Annual salary: €80k–€105k USD."), undefined);
  assert.equal(greenhouseAnnualSalary("Annual salary: $80k–$105k USD. Annual salary: $90k–$120k USD."), undefined);
});

test("an explicit annual Greenhouse ceiling enters the configured pay-floor gate", () => {
  const compensation = greenhouseAnnualSalary("Salary: $80,000 to $105,000 USD per year");
  assert.deepEqual(compensation, { minimum: 80_000, maximum: 105_000,
    currency: "USD", period: "year" });
  const base = { title: "Senior Engineer", description: "TypeScript Node.js",
    location: "Worldwide", remote: true, employmentType: "full_time", compensation };
  const profile = (minimumCompensation) => ({ skills: ["TypeScript", "Node.js"],
    preferences: { locations: ["Worldwide"], fullTime: { jobTitles: ["Senior Engineer"],
      minimumCompensation, compensationCurrency: "USD", compensationPeriod: "year" } } });
  assert.match(scoreOpportunity(base, profile(110_000), "full_time").scoreDetails.hardExclusion,
    /below the configured minimum/);
  assert.equal(scoreOpportunity(base, profile(100_000), "full_time").scoreDetails.hardExclusion,
    undefined);
});
