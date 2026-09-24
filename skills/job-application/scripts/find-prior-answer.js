#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [company, question] = process.argv.slice(2);
if (!company || !question) {
  console.error('usage: node find-prior-answer.js "Company" "Question"');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companyKey = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const employerKeys = (app) => {
  const keys = new Set([companyKey(app.company)]);
  for (const raw of [app.applyUrl, app.url, app.listingUrl]) {
    try {
      const url = new URL(raw);
      if (["jobs.ashbyhq.com", "job-boards.greenhouse.io", "jobs.lever.co"].includes(url.hostname)) {
        keys.add(companyKey(url.pathname.split("/").filter(Boolean)[0]));
      }
    } catch { /* A missing or non-URL listing supplies no employer identity. */ }
  }
  return keys;
};
const stop = new Set("a an and are as at be been by can considered did do does for from have how i in is it me my of on or our past please something that the their there this time to us was what when where which who why with would you your youve".split(" "));
const words = (value) => new Set(String(value ?? "").toLowerCase()
  .replace(/\([^)]*do not use ai[^)]*\)/g, " ")
  .replace(/[^a-z0-9]+/g, " ").split(/\s+/)
  .filter((word) => word.length > 2 && !stop.has(word)));
const target = words(question);

let log;
try {
  log = JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts/jobctl.js"), "application-log"], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024
  }));
} catch {
  console.error("Could not read the job application log");
  process.exit(1);
}

const matches = [];
for (const app of log.items ?? []) {
  if (app.status !== "submitted" || !employerKeys(app).has(companyKey(company))) continue;
  for (const item of app.questionsAndAnswers ?? []) {
    if (typeof item.answer !== "string" || !item.answer.trim()) continue;
    const previous = words(item.question);
    const overlap = [...target].filter((word) => previous.has(word)).length;
    if (overlap < 2 || Math.min(target.size, previous.size) < 2) continue;
    const containment = overlap / Math.min(target.size, previous.size);
    const union = new Set([...target, ...previous]).size;
    const score = 0.7 * containment + 0.3 * overlap / union;
    if (score < 0.65) continue;
    matches.push({ score: Number(score.toFixed(3)), company: app.company, title: app.title,
      applicationId: app.applicationId, status: app.status, question: item.question, answer: item.answer });
  }
}
matches.sort((a, b) => b.score - a.score || b.answer.length - a.answer.length);
console.log(JSON.stringify({ company, question, candidates: matches.slice(0, 8) }, null, 2));
