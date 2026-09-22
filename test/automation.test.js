import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium } from "playwright";
import { automateApplication } from "../worker/automation.js";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

const profile = {
  id: "person-one",
  contact: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" },
  links: {}, documents: {}, applicationAnswers: {}
};

function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function run(html, answers = {}, profileOverride = profile, applicationOverride = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const artifactsDirectory = await mkdtemp(path.join(os.tmpdir(), "job-worker-test-"));
  try {
    return await automateApplication({
      page, profile: profileOverride,
      opportunity: { applyUrl: dataUrl(html) },
      application: { id: "application-one", answers, ...applicationOverride },
      artifactsDirectory
    });
  } finally {
    await context.close();
  }
}

test("worker pauses for an unknown required answer", async () => {
  const result = await run(`
    <form>
      <label>First name <input name="first_name" required></label>
      <label>Email address <input name="email" type="email" required></label>
      <label>Years of Kotlin experience <input name="kotlin_years" type="number" required></label>
      <button type="submit">Submit Application</button>
    </form>
  `);
  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.requirements[0].fields, ["kotlin_years"]);
});

test("an explicit missing employer posting stops without a form review", async () => {
  const result = await run(`<main><h1>Job not found</h1><p>The job you requested was not found.</p>
    <button>Cookie Management</button></main>`);
  assert.equal(result.status, "posting_unavailable");
  assert.equal(result.reasonCode, "posting_not_found");
  assert.equal(result.checkpoint.fields.length, 0);
});

test("worker fills known facts and records a verified submission receipt", async () => {
  const result = await run(`
    <form onsubmit="event.preventDefault(); document.body.innerHTML='<h1>Thank you, your application was submitted</h1>'">
      <label>First name <input name="first_name" required></label>
      <label>Last name <input name="last_name" required></label>
      <label>Email address <input name="email" type="email" required></label>
      <button type="submit">Submit Application</button>
    </form>
  `);
  assert.equal(result.status, "submitted");
  assert.equal(result.receipt.simulated, false);
  assert.match(result.receipt.screenshotSha256, /^[a-f0-9]{64}$/);
});

test("worker durably marks final action immediately before clicking submit", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const artifactsDirectory = await mkdtemp(path.join(os.tmpdir(), "job-worker-test-"));
  const html = `<form onsubmit="event.preventDefault(); document.body.textContent='Application submitted'">
    <button type="submit">Submit Application</button></form>`;
  const phases = [];
  try {
    const result = await automateApplication({ page, profile,
      opportunity: { applyUrl: dataUrl(html) }, application: { id: "application-one", answers: {} },
      artifactsDirectory, markFinalActionStarted: async () => {
        phases.push("marked");
        assert.equal(await page.locator("form").count(), 1);
      } });
    assert.equal(result.status, "submitted");
    assert.deepEqual(phases, ["marked"]);
  } finally { await context.close(); }
});

test("required checkboxes become explicit attestations", async () => {
  const result = await run(`
    <form>
      <label><input name="truthful" type="checkbox" required> I certify this is truthful</label>
      <button type="submit">Submit Application</button>
    </form>
  `, {}, { ...profile, applicationAnswers: { truthful: "Yes" } });
  assert.equal(result.status, "needs_input");
  assert.equal(result.requirements[0].kind, "legal_attestation");
});

test("worker uploads a resume through a CSS-hidden native file input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-worker-document-"));
  const resume = path.join(directory, "resume.pdf");
  await writeFile(resume, "test resume");
  const result = await run(`
    <form onsubmit="event.preventDefault(); document.body.innerHTML = document.querySelector('input[type=file]').files.length ? '<h1>Application submitted</h1>' : '<h1>Missing</h1>'">
      <label>Resume <input style="display:none" name="resume" type="file" required></label>
      <button type="submit">Submit Application</button>
    </form>
  `, {}, { ...profile, documents: { resume } });
  assert.equal(result.status, "submitted");
});

test("worker recognizes composite resume labels and full-name labels", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-worker-document-"));
  const resume = path.join(directory, "resume.pdf");
  await writeFile(resume, "test resume");
  const result = await run(`
    <form onsubmit="event.preventDefault(); document.body.textContent='Application submitted'">
      <label>First and last name <input name="candidate_name" required></label>
      <label>CV or resume <input style="display:none" name="candidate_cv" type="file" required></label>
      <button type="submit">Submit Application</button>
    </form>
  `, {}, { ...profile, documents: { resume } });
  assert.equal(result.status, "submitted");
});

test("success text that existed before submit is not evidence", async () => {
  const result = await run(`
    <p>Application submitted messages appear here after processing.</p>
    <form onsubmit="event.preventDefault()">
      <button type="submit">Submit Application</button>
    </form>
  `);
  assert.equal(result.status, "needs_human");
  assert.equal(result.requirements[0].kind, "submission_unverified");
});

test("worker waits for delayed client-side submission confirmation", async () => {
  const result = await run(`
    <form onsubmit="event.preventDefault(); setTimeout(() => { document.body.innerHTML='<h1>Thank you, your application was submitted</h1>' }, 1200)">
      <label>First name <input name="first_name" required></label>
      <button type="submit">Submit Application</button>
    </form>
  `);
  assert.equal(result.status, "submitted");
});

test("custom validation after Next requests the field even without native required", async () => {
  const result = await run(`<form><div>
    <label for="motivation">Why this company?</label><textarea id="motivation" name="motivation"></textarea>
    <button type="button" onclick="if (!document.querySelector('textarea').value.trim()) {
      if (!document.querySelector('.text-red-500')) this.insertAdjacentHTML('beforebegin',
        '<p class=text-red-500>Please write at least 50 words</p>');
    } else document.body.textContent='Next step'">Continue</button></div>
  </form>`);
  assert.equal(result.status, "needs_input");
  assert.equal(result.requirements[0].kind, "missing_answer");
  assert.deepEqual(result.requirements[0].fields, ["motivation"]);
  assert.match(result.requirements[0].message, /at least 50 words/);
  assert.equal(result.phase, "before_final_action");
});

test("an optional-looking file field with an inline error blocks final review", async () => {
  const result = await run(`<form><div><label>CV / Résumé</label>
    <div><input id="cv-upload" type="file"><label for="cv-upload">Click to upload your CV</label></div>
    <p class="text-red-500">Please upload your CV</p></div>
    <button type="submit">Submit application</button></form>`, {}, profile,
  { finalApprovalRequired: true });
  assert.equal(result.status, "needs_input");
  assert.equal(result.requirements[0].kind, "missing_answer");
  assert.deepEqual(result.requirements[0].fields, ["cv-upload"]);
  assert.equal(result.phase, "before_final_action");
});

test("an unfilled optional file has a stable final preview", async () => {
  const result = await run(`<form><label>Optional document <input type="file" id="optional-file"></label>
    <button type="submit">Submit application</button></form>`, {}, profile,
  { finalApprovalRequired: true });
  assert.equal(result.status, "needs_input");
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.equal(result.requirements[0].preview.unfilled[0].key, "optional-file");
});

test("worker follows Apply Now before inspecting unrelated landing-page forms", async () => {
  const result = await run(`
    <div id="landing">
      <label>Newsletter email <input name="newsletter" required></label>
      <button onclick="document.querySelector('#landing').remove(); document.querySelector('#application').hidden=false">Apply Now</button>
    </div>
    <form id="application" hidden onsubmit="event.preventDefault(); document.body.textContent='Application submitted'">
      <input name="your-name" required>
      <input name="your-email" required>
      <button type="submit">Submit Application</button>
    </form>
  `);
  assert.equal(result.status, "submitted");
});

test("a disabled duplicate Apply button does not make the start action ambiguous", async () => {
  const result = await run(`<button onclick="this.remove();document.querySelector('form').hidden=false">Apply for this job</button>
    <button disabled>Apply for this job</button>
    <form hidden><label>First name <input name="first_name" required></label>
      <button type="submit">Submit application</button></form>`, {}, profile,
  { finalApprovalRequired: true });
  assert.equal(result.status, "needs_input");
  assert.equal(result.requirements[0].kind, "final_submission_approval");
});

test("worker follows a plain Apply button and an Apply manually handoff", async () => {
  const result = await run(`
    <div id="landing">
      <button onclick="this.parentElement.remove(); document.querySelector('#handoff').hidden=false">APPLY</button>
    </div>
    <div id="handoff" hidden>
      <button onclick="this.parentElement.remove(); document.querySelector('#application').hidden=false">Apply manually</button>
    </div>
    <form id="application" hidden onsubmit="event.preventDefault(); document.body.textContent='Application submitted'">
      <label>First name <input name="first_name" required></label>
      <label>Email address <input name="email" type="email" required></label>
      <button type="submit">Submit Application</button>
    </form>
  `);
  assert.equal(result.status, "submitted");
});

test("worker prefers Apply over unrelated authentication controls", async () => {
  const result = await run(`
    <div id="landing">
      <button onclick="this.parentElement.remove(); document.querySelector('#application').hidden=false">APPLY</button>
      <button>Sign in</button>
    </div>
    <form id="application" hidden onsubmit="event.preventDefault(); document.body.textContent='Application submitted'">
      <label>First name <input name="first_name" required></label>
      <button type="submit">Submit Application</button>
    </form>
  `);
  assert.equal(result.status, "submitted");
});

test("approval mode previews every field without clicking submit and redacts secrets", async () => {
  const html = `
    <form onsubmit="event.preventDefault(); document.body.innerHTML='<h1>Application submitted</h1>'">
      <label>First name <input name="first_name" required></label>
      <label>Password <input name="password" type="password" required></label>
      <label>Optional note <textarea name="note"></textarea></label>
      <button type="submit">Submit Application</button>
    </form>
  `;
  const credentialProfile = { ...profile, siteCredential: {
    origin: "data:text/html", username: "ada@example.test", password: "do-not-show", generated: false
  } };
  const previewed = await run(html, {}, credentialProfile, { finalApprovalRequired: true });
  assert.equal(previewed.status, "needs_input");
  const requirement = previewed.requirements[0];
  assert.equal(requirement.kind, "final_submission_approval");
  assert.equal(requirement.preview.unfilled.find((field) => field.key === "note").required, false);
  assert.equal(requirement.preview.filled.find((field) => field.key === "password").value, "[stored securely]");
  assert.doesNotMatch(JSON.stringify(requirement), /do-not-show/);

  const submitted = await run(html, {}, credentialProfile, {
    finalApprovalRequired: true,
    finalSubmissionApproval: { previewFingerprint: requirement.previewFingerprint }
  });
  assert.equal(submitted.status, "submitted");
});

test("changed form invalidates an earlier final approval", async () => {
  const first = await run(`
    <form><label>First name <input name="first_name" required></label><button type="submit">Submit Application</button></form>
  `, {}, profile, { finalApprovalRequired: true });
  const changed = await run(`
    <form><label>First name <input name="first_name" required></label><label>Note <input name="note"></label><button type="submit">Submit Application</button></form>
  `, {}, profile, { finalApprovalRequired: true, finalSubmissionApproval: {
    previewFingerprint: first.requirements[0].previewFingerprint
  } });
  assert.equal(changed.status, "needs_input");
  assert.notEqual(changed.requirements[0].previewFingerprint, first.requirements[0].previewFingerprint);
});

test("unknown select questions include options and recommend a typed answer", async () => {
  const result = await run(`
    <form><label>Work authorization <select name="authorization" required><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label><button type="submit">Submit Application</button></form>
  `);
  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.requirements[0].options.map((option) => option.value), ["yes", "no"]);
  assert.equal(result.requirements[0].recommendation, "custom");
});

test("standard login uses only the matching site credential before applying", async () => {
  const result = await run(`
    <form onsubmit="event.preventDefault(); this.remove(); document.querySelector('#application').hidden = false">
      <h1>Sign in</h1>
      <label>Email <input name="email" type="email" required></label>
      <label>Password <input name="password" type="password" required></label>
      <button type="submit">Sign in</button>
    </form>
    <form id="application" hidden onsubmit="event.preventDefault(); document.body.textContent = 'Application submitted'">
      <label>First name <input name="first_name" required></label>
      <button type="submit">Submit Application</button>
    </form>
  `, {}, { ...profile, siteCredential: {
    origin: "data:text/html", username: "ada@example.test", password: "vault-secret", generated: false
  } });
  assert.equal(result.status, "submitted");
  assert.doesNotMatch(JSON.stringify(result), /vault-secret/);
});

test("missing account credentials offer managed signup with a safe recommendation", async () => {
  const result = await run(`
    <h1>Sign in</h1><a href="#signup">Create account</a>
    <form><label>Email <input name="email" required></label><label>Password <input name="password" type="password" required></label><button type="submit">Sign in</button></form>
  `);
  assert.equal(result.status, "needs_input");
  assert.equal(result.requirements[0].kind, "account_credentials");
  assert.equal(result.requirements[0].options[0].value, "generate");
  assert.equal(result.requirements[0].options[0].recommended, true);
});

test("MFA and verification fields always pause for owner input", async () => {
  const result = await run(`
    <form><label>One-time verification code <input name="otp" required></label><button type="submit">Continue</button></form>
  `);
  assert.equal(result.status, "needs_input");
  assert.equal(result.requirements[0].kind, "authentication_verification");
  assert.equal(result.requirements[0].recommendation, "custom");
});
