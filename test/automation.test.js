import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium } from "playwright";
import { automateApplication, greenhouseResumeUploaded, unavailablePostingUrl,
  waitForSubmissionEvidence } from "../worker/automation.js";

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

async function run(html, answers = {}, profileOverride = profile, applicationOverride = {}, setup,
  callbacks = {}, opportunityOverride = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const artifactsDirectory = await mkdtemp(path.join(os.tmpdir(), "job-worker-test-"));
  try {
    if (setup) await setup(page);
    return await automateApplication({
      page, profile: profileOverride,
      opportunity: { applyUrl: dataUrl(html), ...opportunityOverride },
      application: { id: "application-one", answers, ...applicationOverride },
      artifactsDirectory, ...callbacks
    });
  } finally {
    await context.close();
  }
}

test("standing policy requires a live permit and checks it before Submit", async () => {
  const html = `<form onsubmit="event.preventDefault();document.body.innerHTML='<h2>Success</h2><p>Your application was successfully submitted.</p>'">
    <label>Email<input name="email" type="email" required></label>
    <button type="submit">Submit Application</button></form>`;
  const application = { standingPolicyVersion: 1, claim: { attemptId: "attempt-one" } };
  const held = await run(html, {}, profile, application, undefined, {
    authorizeFinal: async () => ({ decision: "hold", reasonCodes: ["policy_revoked"] }),
    commitFinal: async () => ({ committed: true })
  });
  assert.equal(held.requirements[0].kind, "final_policy_hold");
  let commits = 0;
  const permitted = await run(html, {}, profile, application, undefined, {
    authorizeFinal: async () => ({ decision: "permit", permit: "permit-one" }),
    commitFinal: async (input) => { commits += 1; assert.equal(input.permit, "permit-one");
      return { committed: true }; }
  });
  assert.equal(permitted.status, "submitted");
  assert.equal(commits, 1);
  const revoked = await run(html, {}, profile, application, undefined, {
    authorizeFinal: async () => ({ decision: "permit", permit: "permit-one" }),
    commitFinal: async () => { throw new Error("revoked"); }
  });
  assert.equal(revoked.requirements[0].kind, "final_policy_revoked");
});

test("a form mutation during the policy decision invalidates the final action", async () => {
  let commits = 0;
  let marked = 0;
  let applicationPage;
  const result = await run(`<form onsubmit="event.preventDefault();document.body.textContent='fixture submitted'">
    <label>Email<input name="email" type="email" required></label>
    <button type="submit">Submit Application</button></form>`, {}, profile,
  { standingPolicyVersion: 1, claim: { attemptId: "attempt-one" } },
  async (page) => { applicationPage = page; }, {
    authorizeFinal: async () => {
      // A delayed ATS render or script may alter a field while the worker is
      // awaiting the server policy decision.
      await applicationPage.locator("input[name=email]").evaluate((element) => {
        element.value = "changed@example.test";
      });
      return { decision: "permit", permit: "permit-one" };
    },
    commitFinal: async () => { commits += 1; return { committed: true }; },
    markFinalActionStarted: async () => { marked += 1; }
  });
  assert.equal(result.requirements[0].kind, "final_review_changed");
  assert.equal(commits, 0);
  assert.equal(marked, 0);
});

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

test("visual required markers cannot produce an empty final approval", async () => {
  const result = await run(`<form>
    <label>First name* <span class="sr-only">Required</span><input name="first_name"></label>
    <label>Years of backend experience* <span class="sr-only">Required</span><input name="years" type="number"></label>
    <button type="submit">Submit Application</button>
  </form>`, {}, profile, { finalApprovalRequired: true });
  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.requirements.map((item) => item.fields[0]), ["years"]);
  assert.ok(result.requirements.every((item) => item.kind !== "final_submission_approval"));
});

test("visually required option groups use their question and choices", async () => {
  const result = await run(`<form>
    <fieldset><legend>Which domains do you know?* <span>Required</span></legend>
      <label><input type="checkbox" name="domains" value="cards">Cards</label>
      <label><input type="checkbox" name="domains" value="payments">Payments</label>
    </fieldset>
    <fieldset><legend>Preferred schedule* <span>Required</span></legend>
      <label><input type="radio" name="schedule" value="now">Immediate</label>
      <label><input type="radio" name="schedule" value="later">Later</label>
    </fieldset>
    <button type="submit">Submit Application</button>
  </form>`, { "Which domains do you know?* Required": ["Payments"] }, profile,
  { finalApprovalRequired: true });
  assert.equal(result.status, "needs_input");
  assert.equal(result.requirements.length, 1);
  assert.deepEqual(result.requirements[0].fields, ["schedule"]);
  assert.deepEqual(result.requirements[0].options.map((item) => item.label), ["Immediate", "Later"]);
});

test("custom combobox values are committed through an exact visible option", async () => {
  const result = await run(`<form>
    <label>Country* <span>Required</span><input id="country" role="combobox"
      oninput="document.querySelector('[role=listbox]').hidden=false"></label>
    <div role="listbox" hidden><button type="button" role="option"
      onclick="country.value='Portugal';this.parentElement.hidden=true">Portugal</button></div>
    <button type="submit">Submit Application</button>
  </form>`, {}, { ...profile, contact: { ...profile.contact, country: "Portugal" } },
  { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.deepEqual(result.requirements[0].preview.filled.map((field) => field.value), ["Portugal"]);
});

test("dynamic combobox rerenders converge without refilling committed choices", async () => {
  const result = await run(`<form>
    <label>Country* Required <input id="country" role="combobox"
      oninput="country_box.hidden=false"></label>
    <div id="country_box" role="listbox" hidden><button type="button" role="option"
      onclick="country.value='Portugal';country_box.hidden=true;this.parentElement.insertAdjacentHTML('afterend','<input type=hidden value=PT>')">Portugal</button></div>
    <label>Location* Required <input id="location" role="combobox"
      oninput="location_box.hidden=false"></label>
    <div id="location_box" role="listbox" hidden><button type="button" role="option"
      onclick="location.value='Lisbon, Portugal';location_box.hidden=true;this.parentElement.insertAdjacentHTML('afterend','<input type=hidden value=Lisbon>')">Lisbon, Portugal</button></div>
    <button type="submit">Submit Application</button>
  </form>`, {}, { ...profile, contact: { ...profile.contact, country: "Portugal", city: "Lisbon",
    location: "Lisbon, Portugal" } },
  { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.deepEqual(result.requirements[0].preview.filled.map((field) => field.value),
    ["Portugal", "Lisbon, Portugal"]);
});

test("radio answers verify by readable label or stored option value", async () => {
  const byLabel = await run(`<form><fieldset><legend>Visa sponsorship* Required</legend>
    <label><input type="radio" name="visa" value="true">Yes</label>
    <label><input type="radio" name="visa" value="false">No</label></fieldset>
    <button type="submit">Submit Application</button></form>`, { visa: "No" }, profile,
  { finalApprovalRequired: true });
  assert.equal(byLabel.requirements[0].preview.filled[0].value, "No");
  const byValue = await run(`<form><fieldset><legend>Notice* Required</legend>
    <label><input type="radio" name="notice" value="1">Immediate Available</label>
    <label><input type="radio" name="notice" value="2">Two weeks</label></fieldset>
    <button type="submit">Submit Application</button></form>`, { notice: "1" }, profile,
  { finalApprovalRequired: true });
  assert.equal(byValue.requirements[0].preview.filled[0].value, "Immediate Available");
});

test("delayed LinkedIn save loss holds before final review", async () => {
  const result = await run(`<form>
    <label>LinkedIn URL <input name="linkedin_url"
      onblur="setTimeout(() => { this.value = ''; }, 180)"></label>
    <button type="submit">Submit Application</button></form>`, {},
  { ...profile, links: { linkedin: "https://www.linkedin.com/in/example/" } },
  { finalApprovalRequired: true });
  assert.equal(result.status, "needs_input");
  assert.equal(result.requirements[0].kind, "final_review_changed");
  assert.deepEqual(result.requirements[0].fields, ["linkedin_url"]);
});

test("a radio choice that the form discards is held before Submit", async () => {
  const result = await run(`<form><fieldset><legend>Availability</legend>
    <label><input type="radio" name="availability" value="now"
      onclick="setTimeout(() => { this.checked = false; }, 180)">Now</label>
    <label><input type="radio" name="availability" value="later">Later</label>
    </fieldset><button type="submit">Submit Application</button></form>`,
  { availability: "Now" }, profile, { finalApprovalRequired: true });
  assert.equal(result.status, "needs_input");
  assert.equal(result.requirements[0].kind, "final_review_changed");
});

test("Next takes precedence over Submit and newly revealed required fields hold", async () => {
  const result = await run(`<form onsubmit="event.preventDefault();document.body.textContent='fixture submitted'">
    <section id="first"><label>First name<input name="first_name" required></label>
      <button type="button" onclick="first.hidden=true;second.hidden=false">Next</button>
      <button type="submit">Submit Application</button></section>
    <section id="second" hidden><label>Years of Rust experience<input name="rust_years" required></label>
      <button type="submit">Submit Application</button></section></form>`);
  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.requirements[0].fields, ["rust_years"]);
  assert.equal(result.checkpoint.steps.length, 2);
});

test("a success-shaped URL with an active application form is not a receipt", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(dataUrl(`<form><label>Email<input name="email"></label>
      <button type="submit">Submit Application</button></form>`));
    const previousUrl = page.url();
    await page.goto(dataUrl(`<form><label>Email<input name="email"></label>
      <button type="submit">Submit Application</button></form><p>success</p>`));
    assert.equal(await waitForSubmissionEvidence(page, previousUrl, "", 300), false);
  } finally { await context.close(); }
});

test("403 and 429 stop before any final action", async () => {
  for (const status of [403, 429]) {
    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "text/html" });
      response.end("<h1>Access restricted</h1>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const result = await automateApplication({ page, profile,
        opportunity: { applyUrl: `http://127.0.0.1:${server.address().port}/apply` },
        application: { id: "blocked-application", answers: {} },
        artifactsDirectory: await mkdtemp(path.join(os.tmpdir(), "job-worker-blocked-")) });
      assert.equal(result.requirements[0].kind, "access_restricted");
      assert.equal(result.phase, "before_final_action");
    } finally {
      await context.close();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("visual required text does not break deterministic profile aliases", async () => {
  const result = await run(`<form>
    <label>First name* <span>Required</span><input name="candidate[first_name]"></label>
    <label>Please share a link to your Linkedin profile.** <span>Required</span><input name="linkedin"></label>
    <label>How many years of backend development experience do you have with Node.js and TypeScript?*
      <span>Required</span><input name="node_years" type="number"></label>
    <fieldset><legend>Locations* <span>Required</span></legend>
      <label><input type="checkbox" name="locations" value="romania">Romania</label>
      <label><input type="checkbox" name="locations" value="portugal">Portugal</label>
    </fieldset>
    <button type="submit">Submit Application</button>
  </form>`, {}, { ...profile,
    contact: { ...profile.contact, country: "Portugal" },
    links: { linkedin: "https://www.linkedin.com/in/example/" },
    applicationAnswers: { nodejs_years: 5 }
  }, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.deepEqual(result.requirements[0].preview.filled.map((field) => field.value),
    ["Ada", "https://www.linkedin.com/in/example/", "5", "Yes"]);
});

test("phone widgets may normalize spacing without invalidating the verified number", async () => {
  const result = await run(`<form><label>Phone number with country code
    <input name="phone" type="tel" oninput="this.value=this.value.replace(/\\s/g,'')"></label>
    <button type="submit">Submit Application</button></form>`, {}, {
    ...profile, contact: { ...profile.contact, phone: "+1 202 555 0139" }
  }, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.equal(result.requirements[0].preview.filled[0].value, "+12025550139");
});

test("worker fills safe fields before pausing for an embedded challenge", async () => {
  const result = await run(`
    <form>
      <label>First name <input name="first_name" required></label>
      <label>Email address <input name="email" type="email" required></label>
      <button type="submit">Submit Application</button>
    </form>
    <iframe src="data:text/html,recaptcha-challenge"></iframe>
  `);
  assert.equal(result.status, "needs_human");
  assert.equal(result.requirements[0].kind, "human_challenge");
  assert.deepEqual(result.checkpoint.fields.map((field) => [field.key, field.status]),
    [["first_name", "filled"], ["email", "filled"]]);
});

test("invisible reCAPTCHA badge does not block final review", async () => {
  const result = await run(`
    <form>
      <label>First name <input name="first_name" required></label>
      <button type="submit">Submit Application</button>
    </form>
    <iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?size=invisible"></iframe>
  `, {}, profile, { finalApprovalRequired: true }, async (page) => {
    await page.route("https://www.recaptcha.net/**", (route) => route.fulfill({ body: "badge" }));
  });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.equal(result.requirements[0].preview.filled[0].value, "Ada");
});

test("Ashby custom required controls cannot be omitted from final approval", async () => {
  const result = await run(`<form>
    <div class="ashby-application-form-field-entry" data-field-path="location-id">
      <label class="ashby-application-form-question-title _required_a1" for="location-id">Location</label>
      <input role="combobox" placeholder="Start typing...">
    </div>
    <fieldset class="ashby-application-form-input-radio-group">
      <label class="ashby-application-form-question-title _required_a1" for="source-id">How did you hear about us?</label>
      <input type="radio" name="source-id" id="source-job"><label for="source-job">Job board</label>
    </fieldset>
    <div class="ashby-application-form-field-entry" data-field-path="degree-id">
      <label class="ashby-application-form-question-title _required_a1" for="degree-id">Completed degree?</label>
      <div class="ashby-application-form-input-yesno"><button data-option="yes">Yes</button>
        <button data-option="no">No</button></div>
    </div>
    <button type="submit">Submit Application</button>
  </form>`, {}, profile, { finalApprovalRequired: true });
  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.requirements.map((item) => item.fields[0]),
    ["location-id", "degree-id", "source-id"]);
  assert.ok(result.requirements.every((item) => item.kind !== "final_submission_approval"));
});

test("Ashby custom answers are selected, verified, and shown in final preview", async () => {
  const result = await run(`<form>
    <div class="ashby-application-form-field-entry" data-field-path="location-id">
      <label class="ashby-application-form-question-title _required_a1">Location</label>
      <p class="ashby-application-form-question-description">Country you're currently residing in</p>
      <input role="combobox" aria-expanded="false" oninput="this.setAttribute('aria-expanded','true');document.querySelector('#choices').hidden=false">
      <div id="choices" role="listbox" hidden><div role="option" onclick="document.querySelector('[role=combobox]').value='Portugal';document.querySelector('[role=combobox]').setAttribute('aria-expanded','false');this.parentNode.hidden=true">Portugal</div></div>
    </div>
    <fieldset class="ashby-application-form-input-radio-group">
      <label class="ashby-application-form-question-title _required_a1" for="source-id">How did you hear about us?</label>
      <input type="radio" name="source-id" id="source-job"><label for="source-job">Job board</label>
    </fieldset>
    <div class="ashby-application-form-field-entry" data-field-path="degree-id">
      <label class="ashby-application-form-question-title _required_a1">Completed degree?</label>
      <div class="ashby-application-form-input-yesno">
        <button type="button" data-option="yes" aria-pressed="false" onclick="this.setAttribute('aria-pressed','true')">Yes</button>
        <button type="button" data-option="no" aria-pressed="false">No</button>
      </div>
    </div>
    <button type="submit">Submit Application</button>
  </form>`, { "degree-id": "yes", "source-id": "Job board" },
  { ...profile, contact: { ...profile.contact, country: "Portugal" } }, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.deepEqual(result.requirements[0].preview.filled
    .filter((field) => field.type === "ashby_custom").map((field) => [field.label, field.value]),
  [["Location", "Portugal"], ["Completed degree?", "Yes"], ["How did you hear about us?", "Job board"]]);
});

test("Ashby location and verified work facts reuse the saved profile", async () => {
  const result = await run(`<form>
    <div class="ashby-application-form-field-entry" data-field-path="location-id">
      <label class="ashby-application-form-question-title _required_a1">Where are you located?</label>
      <input role="combobox" aria-expanded="false" oninput="this.setAttribute('aria-expanded','true');choices.hidden=false">
      <div id="choices" role="listbox" hidden><div role="option" onclick="document.querySelector('[role=combobox]').value='Lisbon, Portugal';document.querySelector('[role=combobox]').setAttribute('aria-expanded','false');choices.hidden=true">Lisbon, Portugal</div></div>
    </div>
    <div class="ashby-application-form-field-entry" data-field-path="authorization-id">
      <label class="ashby-application-form-question-title _required_a1">Do you have work authorization to work in that country?</label>
      <div class="ashby-application-form-input-yesno"><button type="button" data-option="yes" aria-pressed="false" onclick="this.setAttribute('aria-pressed','true')">Yes</button><button type="button" data-option="no" aria-pressed="false">No</button></div>
    </div>
    <button type="submit">Submit Application</button>
  </form>`, {}, { ...profile, contact: { ...profile.contact, location: "Lisbon, Portugal", country: "Portugal" },
    applicationAnswers: { "Are you authorized to work in Portugal and for EU companies without visa sponsorship?": "Yes" }
  }, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.deepEqual(result.requirements[0].preview.filled
    .filter((field) => field.type === "ashby_custom").map((field) => [field.label, field.value]),
  [["Where are you located?", "Lisbon, Portugal"],
    ["Do you have work authorization to work in that country?", "Yes"]]);
});

test("Ashby location searches by city when the full saved location has no suggestion", async () => {
  const result = await run(`<form>
    <div class="ashby-application-form-field-entry" data-field-path="location-id">
      <label class="ashby-application-form-question-title _required_a1">Location</label>
      <input role="combobox" aria-expanded="false" oninput="this.setAttribute('aria-expanded','true');choices.hidden=this.value!=='Lisbon'">
      <div id="choices" role="listbox" hidden><div role="option" onclick="document.querySelector('[role=combobox]').value='Lisbon, Portugal';document.querySelector('[role=combobox]').setAttribute('aria-expanded','false');choices.hidden=true">Lisbon, Portugal</div></div>
    </div>
    <button type="submit">Submit Application</button>
  </form>`, { "location-id": "Lisbon, Portugal" }, { ...profile,
    contact: { ...profile.contact, city: "Lisbon", country: "Portugal", location: "Lisbon, Portugal" }
  }, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.equal(result.requirements[0].preview.filled
    .find((field) => field.key === "location-id").value, "Lisbon, Portugal");
});

test("Ashby contract location can fall back from a city to its country", async () => {
  const result = await run(`<form>
    <div class="ashby-application-form-field-entry" data-field-path="location-id">
      <label class="ashby-application-form-question-title _required_a1">What would be your preferred main location for your contract?</label>
      <input role="combobox" aria-expanded="false" oninput="this.setAttribute('aria-expanded','true');choices.hidden=this.value!=='Portugal'">
      <div id="choices" role="listbox" hidden><div role="option" onclick="document.querySelector('[role=combobox]').value='Portugal';document.querySelector('[role=combobox]').setAttribute('aria-expanded','false');choices.hidden=true">Portugal</div></div>
    </div>
    <button type="submit">Submit Application</button>
  </form>`, { "location-id": "Lisbon, Portugal" }, { ...profile,
    contact: { ...profile.contact, city: "Lisbon", country: "Portugal", location: "Lisbon, Portugal" }
  }, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.equal(result.requirements[0].preview.filled
    .find((field) => field.key === "location-id").value, "Portugal");
});

test("an explicit missing employer posting stops without a form review", async () => {
  const result = await run(`<main><h1>Job not found</h1><p>The job you requested was not found.</p>
    <button>Cookie Management</button></main>`);
  assert.equal(result.status, "posting_unavailable");
  assert.equal(result.reasonCode, "posting_not_found");
  assert.equal(result.checkpoint.fields.length, 0);
});

test("an expired Greenhouse role redirect is classified as unavailable", () => {
  assert.equal(unavailablePostingUrl("https://job-boards.greenhouse.io/appfire?error=true"), true);
  assert.equal(unavailablePostingUrl("https://job-boards.greenhouse.io/appfire/jobs/123"), false);
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

test("optional skill checkboxes use only verified profile skills", async () => {
  const result = await run(`<form>
    <label><input name="fast-api" type="checkbox">Fast.api</label>
    <label><input name="asyncio" type="checkbox">Asyncio</label>
    <button type="submit">Submit Application</button>
  </form>`, {}, { ...profile, skills: ["FastAPI"] }, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.deepEqual(result.requirements[0].preview.filled.map((field) => field.label), ["Fast.api"]);
  assert.deepEqual(result.requirements[0].preview.unfilled.map((field) => field.label), ["Asyncio"]);
});

test("common link label variants use verified profile URLs", async () => {
  const result = await run(`<form>
    <label>LinkedIn URL <input name="linkedin_url"></label>
    <label>GitHub URL <input name="github_url"></label>
    <label>Personal Website <input name="personal_website"></label>
    <button type="submit">Submit Application</button>
  </form>`, {}, { ...profile, links: {
    linkedin: "https://www.linkedin.com/in/example/",
    github: "https://github.com/example",
    portfolio: "https://example.com"
  } }, { finalApprovalRequired: true });
  assert.deepEqual(result.requirements[0].preview.filled.map((field) => field.value), [
    "https://www.linkedin.com/in/example/", "https://github.com/example", "https://example.com"
  ]);
});

test("common location variants and exact verified answers are reused deterministically", async () => {
  const result = await run(`<form>
    <label>Location (City)* <input name="candidate-location" required></label>
    <label>Where are you based out of? <input name="based" required></label>
    <label>How did you hear about this job? <input name="source" required></label>
    <button type="submit">Submit Application</button>
  </form>`, {}, { ...profile,
    contact: { ...profile.contact, city: "Lisbon", location: "Lisbon, Portugal" },
    applicationAnswers: { "How did you hear about this job?": "LinkedIn" }
  }, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.deepEqual(result.requirements[0].preview.filled.map((field) => field.value),
    ["Lisbon", "Lisbon, Portugal", "LinkedIn"]);
});

test("verified Portugal work facts and common availability variants are reused", async () => {
  const result = await run(`<form>
    <label>What would be your availability to join us? <input name="availability" required></label>
    <label>Are you authorized to work in Portugal? <input name="authorized" required></label>
    <label>Will you now or in the future require sponsorship for employment visa status? <input name="sponsor" required></label>
    <label>Please share your online CV or LinkedIn profile with us. <input name="online_cv" required></label>
    <button type="submit">Submit Application</button>
  </form>`, {}, { ...profile,
    contact: { ...profile.contact, country: "Portugal", location: "Lisbon, Portugal" },
    links: { linkedin: "https://www.linkedin.com/in/example/" },
    applicationAnswers: {
      "What is your availability?": "Can start now.",
      "Are you authorized to work in Portugal and for EU companies without visa sponsorship?": "Yes",
      "Will you now or in the future require employer visa sponsorship?": "No"
    }
  }, { finalApprovalRequired: true }, undefined);
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.deepEqual(result.requirements[0].preview.filled.map((field) => field.value),
    ["Can start now.", "Yes", "No", "https://www.linkedin.com/in/example/"]);
});

test("work authorization is not copied across residence countries", async () => {
  const result = await run(`<form>
    <label>Are you authorized to work in Portugal? <input name="authorized" required></label>
    <button type="submit">Submit Application</button></form>`, {}, { ...profile,
    contact: { ...profile.contact, country: "Portugal" },
    applicationAnswers: {
      "Are you authorized to work in Bulgaria and for EU companies without visa sponsorship?": "Yes"
    }
  }, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "missing_answer");
  assert.deepEqual(result.requirements[0].fields, ["authorized"]);
});

test("a saved residence country also matches its official two-letter code", async () => {
  const result = await run(`<form>
    <label>Are you authorized to work? <input name="authorized" required></label>
    <button type="submit">Submit Application</button></form>`, {}, { ...profile,
    contact: { ...profile.contact, country: "Bulgaria" },
    applicationAnswers: {
      "Are you authorized to work in Bulgaria and for EU companies without visa sponsorship?": "Yes"
    }
  }, { finalApprovalRequired: true }, undefined, {}, { location: "Remote, BG" });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.deepEqual(result.requirements[0].preview.filled.map((field) => field.value), ["Yes"]);
});

test("Ashby contractor fact uses the saved residence country", async () => {
  const result = await run(`<form>
    <div class="ashby-application-form-field-entry" data-field-path="contractor">
      <label class="ashby-application-form-question-title _required_a1">Can you work full-time as an independent contractor?</label>
      <div class="ashby-application-form-input-yesno"><button type="button" data-option="yes" aria-pressed="false" onclick="this.setAttribute('aria-pressed','true')">Yes</button><button type="button" data-option="no" aria-pressed="false">No</button></div>
    </div><button type="submit">Submit Application</button></form>`, {}, { ...profile,
    contact: { ...profile.contact, country: "Portugal" },
    applicationAnswers: { can_work_full_time_independent_contractor_portugal: "Yes" }
  }, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.deepEqual(result.requirements[0].preview.filled
    .filter((field) => field.type === "ashby_custom").map((field) => field.value), ["Yes"]);
});

test("Ashby authorization does not reuse a saved answer for another country", async () => {
  const result = await run(`<form>
    <div class="ashby-application-form-field-entry" data-field-path="authorization">
      <label class="ashby-application-form-question-title _required_a1">Are you authorized to work in France?</label>
      <div class="ashby-application-form-input-yesno"><button type="button" data-option="yes" aria-pressed="false">Yes</button><button type="button" data-option="no" aria-pressed="false">No</button></div>
    </div><button type="submit">Submit Application</button></form>`, {}, { ...profile,
    contact: { ...profile.contact, country: "Portugal" },
    applicationAnswers: {
      "Are you authorized to work in Portugal and for EU companies without visa sponsorship?": "Yes"
    }
  }, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "missing_answer");
});

test("Ashby submit waits for the last field save triggered by blur", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const artifactsDirectory = await mkdtemp(path.join(os.tmpdir(), "job-worker-test-"));
  await page.route("https://jobs.ashbyhq.com/test/application", (route) => route.fulfill({
    contentType: "text/html", body: `<form onsubmit="event.preventDefault();if(window.saved)document.body.innerHTML='<h1>Application submitted</h1>'">
      <label>Name <input name="name" required></label>
      <label>Email <input name="email" type="email" required onblur="fetch('/api/non-user-graphql',{method:'POST'}).then(()=>window.saved=true)"></label>
      <button type="submit">Submit Application</button></form>`
  }));
  await page.route("https://jobs.ashbyhq.com/api/non-user-graphql", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ contentType: "application/json", body: "{}" });
  });
  try {
    const result = await automateApplication({ page, profile,
      opportunity: { applyUrl: "https://jobs.ashbyhq.com/test/application" },
      application: { id: "application-one", answers: {} }, artifactsDirectory });
    assert.equal(result.status, "submitted");
  } finally { await context.close(); }
});

test("Ashby success wording records a verified receipt", async () => {
  const result = await run(`<form onsubmit="event.preventDefault();document.body.innerHTML='<h2>Success</h2><p>Your application was successfully submitted. We will contact you if there are next steps.</p>'">
    <button type="submit">Submit Application</button></form>`);
  assert.equal(result.status, "submitted");
});

test("explicit employer spam rejection is reported as blocked, not uncertain", async () => {
  const result = await run(`<form onsubmit='event.preventDefault();document.body.textContent="We couldn\\u0027t submit your application. Your application submission was flagged as possible spam."'>
    <button type="submit">Submit Application</button></form>`);
  assert.equal(result.status, "needs_human");
  assert.equal(result.requirements[0].kind, "submission_blocked");
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

test("styled ATS labels activate zero-size checkbox and object-valued radio", async () => {
  const result = await run(`<style>input.choice { position:absolute; width:0; height:0 }</style>
    <form>
      <input class="choice" type="checkbox" id="privacy" name="privacy" required>
      <label for="privacy">I agree to the privacy policy</label>
      <input class="choice" type="radio" id="europe" name="region" value="[object Object]" required>
      <label for="europe">I am based in Europe</label>
      <button type="submit">Submit Application</button>
    </form>`, { privacy: true, region: "I am based in Europe" }, profile,
  { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.deepEqual(result.requirements[0].preview.filled.map((field) => [field.key, field.value]),
    [["privacy", "Yes"], ["region", "I am based in Europe"]]);
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

test("a verified upload remains in review after the ATS replaces its file input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-upload-test-"));
  const resume = path.join(directory, "resume.pdf");
  await writeFile(resume, "resume-body");
  const result = await run(`<form>
    <label>Upload resume* Required <input id="resume" type="file" required
      onchange="this.outerHTML='<span>Uploaded resume.pdf</span>'"></label>
    <label>First name <input name="first_name" required></label>
    <button type="submit">Submit Application</button>
  </form>`, {}, { ...profile, documents: { resume } }, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  const uploaded = result.requirements[0].preview.filled.find((field) => field.type === "file");
  assert.equal(uploaded.value, "resume.pdf");
  assert.deepEqual(uploaded.files, [{ name: "resume.pdf", size: 11 }]);
});

test("a rescanned Greenhouse-style file control retains an exact live upload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-upload-test-"));
  const resume = path.join(directory, "resume.pdf");
  await writeFile(resume, "resume-body");
  const result = await run(`<form>
    <label>Resume <input id="resume" name="resume" type="file" required
      onchange="this.name='resume_backing'; this.id='resume_backing'"></label>
    <button type="submit">Submit Application</button>
  </form>`, {}, { ...profile, documents: { resume } }, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  const fileFields = result.requirements[0].preview.filled.filter((field) => field.type === "file");
  assert.ok(fileFields.some((field) => field.detached === true));
  assert.ok(fileFields.every((field) => field.files[0].name === "resume.pdf"
    && field.files[0].size === 11));
});

test("Greenhouse resume success chip survives final review beside an empty cover-letter input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-upload-test-"));
  const resume = path.join(directory, "resume.pdf");
  await writeFile(resume, "resume-body");
  const url = "https://job-boards.greenhouse.io/example/jobs/12345";
  const html = `<form>
    <div role="group" aria-labelledby="upload-label-resume" class="file-upload">
      <div id="upload-label-resume">Resume/CV*</div>
      <div class="file-upload__wrapper"><label for="resume">Attach</label>
        <input id="resume" type="file"></div>
    </div>
    <div role="group" aria-labelledby="upload-label-cover_letter" class="file-upload">
      <div id="upload-label-cover_letter">Cover Letter</div>
      <div class="file-upload__wrapper"><label for="cover_letter">Attach</label>
        <input id="cover_letter" type="file"></div>
    </div>
    <button type="submit">Submit Application</button>
  </form><script>
    document.querySelector('#resume').addEventListener('change', (event) => {
      event.target.closest('.file-upload').querySelector('.file-upload__wrapper').innerHTML =
        '<div class="file-upload__filename">resume.pdf<button type="button" aria-label="Remove file"></button></div>';
    });
  </script>`;
  const result = await run(html, {}, { ...profile, documents: { resume } },
    { finalApprovalRequired: true },
    async (page) => page.route(url, (route) => route.fulfill({ status: 200,
      contentType: "text/html", body: html })), {}, { applyUrl: url });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.ok(result.requirements[0].preview.filled.some((field) =>
    field.key === "resume" && field.value === "resume.pdf"));
});

test("Greenhouse immediate upload replacement survives a detached file-control response", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-upload-test-"));
  const resume = path.join(directory, "resume.pdf");
  await writeFile(resume, "resume-body");
  const url = "https://job-boards.greenhouse.io/example/jobs/12345";
  const html = `<form>
    <div role="group" aria-labelledby="upload-label-resume" class="file-upload">
      <div id="upload-label-resume">Resume/CV*</div>
      <div class="file-upload__wrapper"><label for="resume">Attach</label>
        <input id="resume" type="file"></div>
    </div>
    <div role="group" aria-labelledby="upload-label-cover_letter" class="file-upload">
      <div id="upload-label-cover_letter">Cover Letter</div>
      <div class="file-upload__wrapper"><label for="cover_letter">Attach</label>
        <input id="cover_letter" type="file"></div>
    </div>
    <button type="submit">Submit Application</button>
  </form><script>
    document.querySelector('#resume').addEventListener('change', (event) => {
      event.target.closest('.file-upload').querySelector('.file-upload__wrapper').innerHTML =
        '<div class="file-upload__filename">resume.pdf<button type="button" aria-label="Remove file"></button></div>';
    });
  </script>`;
  const result = await run(html, {}, { ...profile, documents: { resume } },
    { finalApprovalRequired: true }, async (page) => {
      const originalLocator = page.locator.bind(page);
      page.locator = (selector, ...args) => {
        const locator = originalLocator(selector, ...args);
        if (!selector.startsWith("input:not([type=hidden])")) return locator;
        const originalNth = locator.nth.bind(locator);
        locator.nth = (index) => {
          const control = originalNth(index);
          const originalSetInputFiles = control.setInputFiles.bind(control);
          control.setInputFiles = async (...files) => {
            await originalSetInputFiles(...files);
            throw new Error("The upload input detached while Playwright handled the change event");
          };
          return control;
        };
        return locator;
      };
      await page.route(url, (route) => route.fulfill({ status: 200,
        contentType: "text/html", body: html }));
    }, {}, { applyUrl: url });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.deepEqual(result.requirements[0].preview.filled.find((field) => field.key === "resume")?.files,
    [{ name: "resume.pdf", size: 11 }]);
  assert.ok(result.requirements[0].preview.unfilled.some((field) => field.key === "cover_letter"));
});

test("Greenhouse success chip without a captured upload cannot enter final approval", async () => {
  const url = "https://job-boards.greenhouse.io/example/jobs/12345";
  const html = `<form>
    <div role="group" aria-labelledby="upload-label-resume" class="file-upload">
      <div id="upload-label-resume">Resume/CV*</div>
      <div class="file-upload__filename">resume.pdf
        <button type="button" aria-label="Remove file"></button></div>
    </div>
    <div role="group" aria-labelledby="upload-label-cover_letter" class="file-upload">
      <div id="upload-label-cover_letter">Cover Letter</div>
      <input id="cover_letter" type="file">
    </div>
    <button type="submit">Submit Application</button>
  </form>`;
  const result = await run(html, {}, profile, { finalApprovalRequired: true },
    async (page) => page.route(url, (route) => route.fulfill({ status: 200,
      contentType: "text/html", body: html })), {}, { applyUrl: url });
  assert.equal(result.requirements[0].kind, "final_review_changed");
  assert.deepEqual(result.requirements[0].fields, ["resume"]);
});

test("Greenhouse drafted prose retains the verified resume in the approval and fingerprint", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-upload-test-"));
  const resume = path.join(directory, "resume.pdf");
  const url = "https://job-boards.greenhouse.io/example/jobs/12345";
  const html = `<form>
    <div role="group" aria-labelledby="upload-label-resume" class="file-upload">
      <div id="upload-label-resume">Resume/CV*</div>
      <div class="file-upload__wrapper"><label for="resume">Attach</label>
        <input id="resume" type="file"></div>
    </div>
    <div role="group" aria-labelledby="upload-label-cover_letter" class="file-upload">
      <div id="upload-label-cover_letter">Cover Letter</div>
      <div class="file-upload__wrapper"><label for="cover_letter">Attach</label>
        <input id="cover_letter" type="file"></div>
    </div>
    <label for="project">Describe a project</label><textarea id="project" required></textarea>
    <button type="submit">Submit Application</button>
  </form><script>
    document.querySelector('#resume').addEventListener('change', (event) => setTimeout(() => {
      event.target.closest('.file-upload').querySelector('.file-upload__wrapper').innerHTML =
        '<div class="file-upload__filename">resume.pdf<button type="button" aria-label="Remove file"></button></div>';
    }, 40));
  </script>`;
  const callbacks = {
    evidencePacket: { applicant: { skills: ["FixtureSkillAlpha"] }, listing: "The test role uses FixtureSkillAlpha." },
    draftProvider: { draft: async ({ questions }) => questions.map((question) => ({
      fieldId: question.fieldId, text: "I use FixtureSkillAlpha.", evidenceIds: ["applicant:skills"]
    })) },
    claimReviewer: { review: async () => ({ supported: true, responsive: true,
      claims: [{ text: "I use FixtureSkillAlpha.", supported: true,
        evidenceIds: ["applicant:skills"] }] }) }
  };
  let applicationPage;
  const setup = async (page) => {
    applicationPage = page;
    await page.route(url, (route) => route.fulfill({ status: 200,
      contentType: "text/html", body: html }));
  };
  const previewForSize = async (body) => {
    await writeFile(resume, body);
    const result = await run(html, {}, { ...profile, skills: ["FixtureSkillAlpha"], documents: { resume } },
      { finalApprovalRequired: true }, setup, callbacks, { applyUrl: url });
    assert.equal(result.requirements[0].kind, "final_submission_approval");
    return result.requirements[0];
  };
  const first = await previewForSize("resume-body");
  const uploaded = first.preview.filled.find((field) => field.key === "resume");
  assert.equal(uploaded.label, "Resume/CV*");
  assert.equal(uploaded.required, true);
  assert.deepEqual(uploaded.files,
    [{ name: "resume.pdf", size: 11 }]);
  assert.ok(first.preview.unfilled.some((field) => field.key === "cover_letter"));
  assert.ok(!first.preview.unfilled.some((field) => field.key === "resume"));
  const second = await previewForSize("resume-body-2");
  assert.deepEqual(second.preview.filled.find((field) => field.key === "resume")?.files,
    [{ name: "resume.pdf", size: 13 }]);
  assert.notEqual(first.previewFingerprint, second.previewFingerprint);
  const missingChip = await run(html, {}, { ...profile, skills: ["FixtureSkillAlpha"], documents: { resume } },
    { finalApprovalRequired: true }, setup, { ...callbacks,
      draftProvider: { draft: async (input) => {
        await applicationPage.locator(".file-upload__filename").evaluate((chip) => chip.remove());
        return callbacks.draftProvider.draft(input);
      } } }, { applyUrl: url });
  assert.equal(missingChip.requirements[0].kind, "final_review_changed");
  assert.deepEqual(missingChip.requirements[0].fields, ["resume"]);
});

test("Greenhouse stale filename text and incomplete uploads lack success evidence", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent(`<form>
    <div role="group" aria-labelledby="upload-label-resume" class="file-upload">
      <div id="upload-label-resume">Resume/CV*</div>
      <div class="file-upload__wrapper"><span>resume.pdf</span></div>
    </div>
    <div role="group" aria-labelledby="upload-label-cover_letter" class="file-upload">
      <div id="upload-label-cover_letter">Cover Letter</div>
      <div class="file-upload__wrapper"><label for="cover_letter">Attach</label>
        <input id="cover_letter" type="file"></div>
    </div>
    <button type="submit">Submit Application</button></form>`);
    const proof = () => page.evaluate(greenhouseResumeUploaded,
      { name: "resume.pdf", formIndex: 0 });
    assert.equal(await proof(), false);
    await page.locator(".file-upload__wrapper").first().evaluate((wrapper) => {
      wrapper.innerHTML = '<div class="file-upload__filename">resume.pdf'
        + '<button type="button" aria-label="Remove file"></button></div>';
    });
    assert.equal(await proof(), true);
    await page.locator(".file-upload__wrapper").first().evaluate((wrapper) => {
      wrapper.insertAdjacentHTML("beforeend", '<div role="progressbar"></div>');
    });
    assert.equal(await proof(), false);
    await page.locator('[role="progressbar"]').evaluate((bar) => bar.remove());
    await page.locator(".file-upload__wrapper").first().evaluate((wrapper) => {
      wrapper.insertAdjacentHTML("beforeend", '<p class="helper-text--error">Upload failed</p>');
    });
    assert.equal(await proof(), false);
  } finally {
    await context.close();
  }
});

test("a rescanned file control that loses the upload pauses final review", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-upload-test-"));
  const resume = path.join(directory, "resume.pdf");
  await writeFile(resume, "resume-body");
  const result = await run(`<form>
    <label>Resume <input id="resume" name="resume" type="file" required
      onchange="this.name='resume_backing'; this.id='resume_backing';
        setTimeout(() => { this.value=''; }, 400)"></label>
    <button type="submit">Submit Application</button>
  </form>`, {}, { ...profile, documents: { resume } }, { finalApprovalRequired: true });
  assert.equal(result.status, "needs_input");
  assert.ok(["final_review_changed", "missing_answer"].includes(result.requirements[0].kind));
});

test("a rescanned file with the same name but a different size pauses final review", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-upload-test-"));
  const resume = path.join(directory, "resume.pdf");
  await writeFile(resume, "resume-body");
  const result = await run(`<form>
    <label>Resume <input id="resume" name="resume" type="file" required
      onchange="this.name='resume_backing'; this.id='resume_backing';
        setTimeout(() => { const files=new DataTransfer();
          files.items.add(new File(['wrong'], 'resume.pdf', {type:'application/pdf'}));
          this.files=files.files; }, 450)"></label>
    <button type="submit">Submit Application</button>
  </form>`, {}, { ...profile, documents: { resume } }, { finalApprovalRequired: true });
  assert.equal(result.status, "needs_input");
  assert.ok(["final_review_changed", "missing_answer"].includes(result.requirements[0].kind));
});

test("two live file inputs with the same upload are ambiguous at final review", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-upload-test-"));
  const resume = path.join(directory, "resume.pdf");
  await writeFile(resume, "resume-body");
  const result = await run(`<form>
    <label>Resume <input id="resume" name="resume" type="file" required
      onchange="this.name='resume_backing'; this.id='resume_backing';
        const copy=document.createElement('input'); copy.type='file';
        copy.files=this.files; copy.style.display='none'; this.form.append(copy)"></label>
    <button type="submit">Submit Application</button>
  </form>`, {}, { ...profile, documents: { resume } }, { finalApprovalRequired: true });
  assert.equal(result.status, "needs_input");
  assert.equal(result.requirements[0].kind, "final_review_changed");
});

test("an upload that disappears without its filename cannot pass final review", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-upload-test-"));
  const resume = path.join(directory, "resume.pdf");
  await writeFile(resume, "resume-body");
  const result = await run(`<form><label>Resume <input name="resume" type="file" required
    onchange="setTimeout(() => { this.outerHTML='<span>Upload pending</span>'; }, 500)"></label>
    <button type="submit">Submit Application</button></form>`, {},
  { ...profile, documents: { resume } }, { finalApprovalRequired: true });
  assert.equal(result.status, "needs_input");
  assert.equal(result.requirements[0].kind, "final_review_changed");
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
    <label for="motivation">Additional details</label><textarea id="motivation" name="motivation"></textarea>
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

test("a portfolio URL is not uploaded into an optional portfolio file control", async () => {
  const result = await run(`<form><label>Attach Portfolio <input type="file" name="portfolio"></label>
    <button type="submit">Submit application</button></form>`, {},
  { ...profile, links: { portfolio: "https://example.test/portfolio" } },
  { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.equal(result.requirements[0].preview.unfilled[0].key, "portfolio");
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

test("worker waits for a delayed application action after the shell loads", async () => {
  const result = await run(`<main id="root"><button>Cookie settings</button></main>
    <script>setTimeout(function () { var button = document.createElement('button');
      button.textContent = 'Apply Now'; button.onclick = function () {
        root.innerHTML = '<form><label>First name <input name="first_name" required></label><button type="submit">Submit Application</button></form>';
      }; root.appendChild(button); }, 700)</script>`,
  {}, profile, { finalApprovalRequired: true });
  assert.equal(result.requirements[0].kind, "final_submission_approval");
  assert.equal(result.requirements[0].preview.filled[0].value, "Ada");
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

test("identical submit controls in the same form are one semantic action", async () => {
  const result = await run(`<form>
    <label>First name <input name="first_name" required></label>
    <button type="submit">Submit Application</button>
    <button type="submit">Submit Application</button>
  </form>`, {}, profile, { finalApprovalRequired: true });
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

test("approval survives a fresh render that changes a control ID", async () => {
  const html = `<form onsubmit="event.preventDefault(); document.body.textContent='Application submitted'">
    <label>First name <input name="first_name" required></label>
    <button type="submit">Submit Application</button></form>
    <script>document.querySelector('input').id = Math.random().toString(36).slice(2)</script>`;
  const first = await run(html, {}, profile, { finalApprovalRequired: true });
  assert.equal(first.requirements[0].kind, "final_submission_approval");
  const second = await run(html, {}, profile, { finalApprovalRequired: true,
    finalSubmissionApproval: { previewFingerprint: first.requirements[0].previewFingerprint } });
  assert.equal(second.status, "submitted");
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
