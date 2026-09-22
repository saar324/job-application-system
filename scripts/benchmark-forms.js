#!/usr/bin/env node
// A small, reproducible synthetic corpus. This measures browser work, not agent time.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const modulePath = path.resolve(process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? "worker/automation.js");
const { automateApplication } = await import(pathToFileURL(modulePath).href);
const variants = [
  ["First name", "Last name", "Email address"],
  ["Given name", "Family name", "Your email"],
  ["Forename", "Surname", "E-mail"],
  ["FIRST NAME", "LAST NAME", "EMAIL"],
  ["first_name", "last_name", "email"],
  ["Firstname", "Lastname", "Email address"]
];
const input = (label, name, type = "text") => `<label>${label} <input name="${name}" type="${type}" required></label>`;
const submit = '<button type="submit">Submit Application</button>';
const cases = variants.flatMap(([first, last, email], variant) => {
  const names = `${input(first, "first_name")}${input(last, "last_name")}`;
  const contact = input(email, "email", "email");
  return [
    { id: `single-${variant}`, html: `<form>${names}${contact}${submit}</form>`, expected: "approval", filled: 3 },
    { id: `two-step-${variant}`, html: `<form id="one">${names}<button type="button" onclick="one.hidden=true;two.hidden=false">Next</button></form><form id="two" hidden>${contact}${submit}</form>`, expected: "approval", filled: 3 },
    { id: `optional-${variant}`, html: `<form>${names}${contact}<label>Portfolio note <textarea name="portfolio_note"></textarea></label>${submit}</form>`, expected: "approval", filled: 3 },
    { id: `unknown-${variant}`, html: `<form>${names}${contact}${input("Years of niche experience", "niche_years", "number")}${submit}</form>`, expected: "missing_answer" },
    { id: `referral-${variant}`, html: `<form>${names}${contact}${input("Referral email", "referral_email", "email")}${submit}</form>`, expected: "missing_answer" }
  ];
});
const profile = { id: "synthetic", contact: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" }, links: {}, documents: {} };
const percentile = (numbers, p) => numbers.length ? numbers[Math.ceil(numbers.length * p) - 1] : null;
const browser = await chromium.launch({ headless: true });
const artifactsDirectory = await mkdtemp(path.join(os.tmpdir(), "job-form-benchmark-"));
const results = [];
try {
  for (const fixture of cases) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const start = performance.now();
    try {
      const result = await automateApplication({ page, profile,
        opportunity: { company: "Example", title: "Engineer", applyUrl: `data:text/html;charset=utf-8,${encodeURIComponent(fixture.html)}` },
        application: { id: fixture.id, answers: {}, finalApprovalRequired: true }, artifactsDirectory });
      const requirements = result.requirements ?? [];
      const approval = requirements.find((item) => item.kind === "final_submission_approval");
      const status = approval ? "approval" : requirements.some((item) => item.kind === "missing_answer") ? "missing_answer" : result.status;
      const filled = approval?.preview?.filled ?? [];
      const valid = status === fixture.expected && (fixture.filled === undefined || filled.length === fixture.filled)
        && (fixture.expected !== "approval" || filled.some((field) => field.value === "ada@example.test"))
        && result.status !== "submitted";
      results.push({ id: fixture.id, valid, status, expected: fixture.expected,
        durationMs: Math.round(performance.now() - start) });
    } catch (error) {
      results.push({ id: fixture.id, valid: false, error: error.message,
        durationMs: Math.round(performance.now() - start) });
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
assert.equal(results.length, 30);
const durations = results.map((item) => item.durationMs).sort((a, b) => a - b);
const report = { fixtureCount: results.length, correct: results.filter((item) => item.valid).length,
  incorrect: results.filter((item) => !item.valid).map((item) => ({ id: item.id, status: item.status,
    expected: item.expected, error: item.error })),
  durationMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), total: durations.reduce((a, b) => a + b, 0) },
  scope: "synthetic Chromium form preparation; excludes search, model, owner wait and live network" };
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--strict")) assert.equal(report.correct, report.fixtureCount);
