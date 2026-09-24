import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { companyQuestion, eligibleProseField, highValueOptionalProseField,
  needsCompanyResearch } from "./draft-provider.js";
import { draftContextFingerprint, reusableApprovedAnswer } from "../src/approved-answers.js";
import { fillAshbyRequiredControls, verifyAshbyRequiredControls } from "./ashby-adapter.js";

const FINAL_BUTTON = /submit(?: application)?|send application|complete application/i;
const NEXT_BUTTON = /next|continue|save and continue|review/i;
const START_BUTTON = /^(?:apply|apply manually)$|apply now|apply for this job|start application/i;
const AUTH_BUTTON = /sign in|log in|create account|register|sign up/i;
const SIGNUP_BUTTON = /create account|register|sign up/i;
const SUCCESS_TEXT = /thank you|application (?:has been |was )?(?:successfully )?submitted|application received|received your application/i;
const BLOCKED_SUBMISSION_TEXT = /we couldn't submit your application[\s\S]*flagged as possible spam/i;
const CHALLENGE_TEXT = /captcha|verify you are human|security check|unusual traffic|cloudflare/i;
const VERIFICATION_FIELD = /\b(otp|one.?time|verification code|security code|authenticator|two.?factor|2fa|mfa|passkey)\b/i;
const NARRATIVE_QUESTION = /\b(?:why|motivation|cover letter|describe|explain|project|challenge|achievement|accomplishment|story|what interests|tell us about)\b/i;
const REUSABLE_FACT_QUESTION = /^(?:how did you hear about (?:this|the) (?:job|role)|referral source|current employer|current job title|notice period|start date|how many years of [a-z0-9 ]+ experience|[a-z ]+ language proficiency)$/;

export async function waitForSubmissionEvidence(page, previousUrl, bodyBeforeSubmit, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const successAlreadyPresent = SUCCESS_TEXT.test(bodyBeforeSubmit);
  while (Date.now() < deadline) {
    const currentUrl = page.url();
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 50_000);
    if (BLOCKED_SUBMISSION_TEXT.test(body)) return false;
    const confirmationUrl = /confirmation|thank|success|submitted/i.test(currentUrl) && currentUrl !== previousUrl;
    const invalidControls = await page.locator("input:invalid, textarea:invalid, select:invalid").count().catch(() => 0);
    const activeForm = await page.locator("form:visible").count().catch(() => 0);
    const newSuccessText = !successAlreadyPresent && SUCCESS_TEXT.test(body)
      && activeForm === 0 && body.length < 2000;
    if ((confirmationUrl || newSuccessText) && activeForm === 0 && invalidControls === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function normalize(value) {
  return String(value ?? "").normalize("NFKD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function escapePattern(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

const countryCodeCache = new Map();
function countryCodeFor(name) {
  const country = normalize(name);
  if (!country) return undefined;
  if (countryCodeCache.has(country)) return countryCodeCache.get(country);
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  let found;
  for (let first = 65; first <= 90 && !found; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      if (normalize(display.of(code)) === country) { found = code; break; }
    }
  }
  countryCodeCache.set(country, found);
  return found;
}

function withoutRequiredMarker(value) {
  return String(value ?? "").replace(/\*+\s*(?:required)?\b/gi, " ")
    .replace(/\brequired\b/gi, " ").replace(/\s+/g, " ").trim();
}

function flattenProfile(profile, currentUrl) {
  const contact = profile.contact ?? {};
  const links = profile.links ?? {};
  const documents = profile.documents ?? {};
  const values = {
    "first name": contact.firstName,
    firstname: contact.firstName,
    "given name": contact.firstName,
    forename: contact.firstName,
    "last name": contact.lastName,
    lastname: contact.lastName,
    surname: contact.lastName,
    "family name": contact.lastName,
    name: contact.fullName ?? [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    "full name": contact.fullName ?? [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    "first and last name": contact.fullName ?? [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    "your name": contact.fullName ?? [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    email: contact.email,
    "e mail": contact.email,
    "email address": contact.email,
    "your email": contact.email,
    phone: contact.phone,
    "phone number": contact.phone,
    "phone number with country code": contact.phone,
    location: contact.location,
    "current location": contact.location,
    city: contact.city,
    "candidate location": contact.city ?? contact.location,
    "location city": contact.city ?? contact.location,
    "where are you based": contact.location,
    "where are you based out of": contact.location,
    country: contact.country,
    "__residence country code": countryCodeFor(contact.country),
    address: contact.address,
    "street address": contact.address,
    "postal code": contact.postalCode,
    postcode: contact.postalCode,
    "zip code": contact.postalCode,
    linkedin: links.linkedin,
    "linkedin profile": links.linkedin,
    "linkedin url": links.linkedin,
    github: links.github,
    "github url": links.github,
    portfolio: links.portfolio,
    website: links.portfolio,
    "personal website": links.portfolio,
    "website url": links.portfolio,
    "online cv or linkedin profile": links.linkedin,
    "please share your online cv or linkedin profile with us": links.linkedin,
    resume: documents.resume,
    cv: documents.resume,
    "cover letter": documents.coverLetter,
  };
  // Reuse only exact normalized questions from the owner's verified answer bank.
  // Limit the generic bank to short, repeatable facts. Legal facts use the
  // jurisdiction-aware paths below; prose requires employer-scoped provenance.
  for (const [question, answer] of Object.entries(profile.applicationAnswers ?? {})) {
    if (answer === undefined || answer === null || answer === "" || typeof answer === "object") continue;
    const key = normalize(question);
    if (!REUSABLE_FACT_QUESTION.test(key)
      || typeof answer === "string" && (answer.length > 120 || /[\r\n]/.test(answer))) continue;
    if (key && values[key] === undefined) values[key] = answer;
  }
  const storedAnswers = profile.applicationAnswers ?? {};
  const residenceCountry = String(contact.country ?? "").trim();
  values["what would be your availability to join us"] = storedAnswers["What is your availability?"]
    ?? storedAnswers.Availability ?? storedAnswers.availability;
  values["what are your strongest professionally used programming languages"] = storedAnswers.Languages;
  values["__residence work authorization"] = residenceCountry ? storedAnswers[
    `Are you authorized to work in ${residenceCountry} and for EU companies without visa sponsorship?`
  ] : undefined;
  values["__visa sponsorship required"] = storedAnswers[
    "Will you now or in the future require employer visa sponsorship?"
  ];
  values["please share a link to your linkedin profile"] = links.linkedin;
  values["how many years of backend development experience do you have with node js and typescript"]
    = storedAnswers.nodejs_years;
  const awsBand = String(storedAnswers.awsExperienceBand ?? "").match(/^\s*(\d+)/)?.[1];
  values["how many years of work experience do you have with aws"] = awsBand;
  values["do you have any experience working with a startup or in a global remote role"]
    = storedAnswers.worked_as_internal_employee_at_saas_startup_or_scaleup === true
      || Number(storedAnswers.remote_work_years_approx) > 0 ? "Yes" : undefined;
  values["what is your current monthly base salary in usd"] = storedAnswers.currentMonthlyBaseSalaryUsd;
  values["what is your expected monthly base salary in usd"] = storedAnswers.expectedMonthlyBaseSalaryUsd;
  values["what is your current residency status in the indicated job location e g open work permit permanent resident citizen etc if you are not currently based in that location please specify your current location"]
    = residenceCountry ? storedAnswers[`Legal residence status in ${residenceCountry}`] : undefined;
  values["are you willing to undergo a reference check and a background check in accordance with local law regulations after accepting the conditional job offer by the end of the hiring process"]
    = storedAnswers.backgroundCheckWilling === true ? "Yes" : undefined;
  if (credentialMatches(profile.siteCredential, currentUrl)) {
    values.username = profile.siteCredential.username;
    values["user name"] = profile.siteCredential.username;
    values.password = profile.siteCredential.password;
    values["new password"] = profile.siteCredential.password;
    values["confirm password"] = profile.siteCredential.password;
    values["password confirmation"] = profile.siteCredential.password;
  }
  return values;
}

function resolveAnswer(field, answers, profileValues, preparedAnswers = {}, approvedAnswers = [], opportunity = {}, skills = [], profile = {}) {
  const candidates = [...new Set([field.name, field.id, field.label, field.groupQuestion]
    .filter(Boolean).flatMap((value) => [value, withoutRequiredMarker(value)]))];
  if (field.type === "checkbox" && field.groupQuestion) {
    for (const candidate of [field.name, field.groupQuestion]) {
      const direct = Object.hasOwn(answers, candidate) ? answers[candidate] : answers[normalize(candidate)];
      if (direct === undefined) continue;
      const selected = Array.isArray(direct) ? direct : [direct];
      return { value: selected.some((item) => normalize(item) === normalize(field.label)),
        source: "application answer" };
    }
  }
  for (const candidate of candidates) {
    if (Object.hasOwn(answers, candidate)) return { value: answers[candidate], source: "application answer" };
    const key = normalize(candidate);
    if (Object.hasOwn(answers, key)) return { value: answers[key], source: "application answer" };
  }
  for (const candidate of candidates) {
    const key = normalize(candidate);
    if (Object.hasOwn(preparedAnswers, candidate)) return { value: preparedAnswers[candidate], source: "drafted prose" };
    if (Object.hasOwn(preparedAnswers, key)) return { value: preparedAnswers[key], source: "drafted prose" };
  }
  const label = normalize(field.label);
  const approved = approvedAnswers.find((item) => {
    if (/authoriz|visa|sponsor|citizen|compens|salary|legal|consent|demograph/i.test(label)) return false;
    return reusableApprovedAnswer(item, profile, opportunity, withoutRequiredMarker(field.label));
  });
  if (approved) return { value: approved.value, source: `approved answer:${approved.id}` };
  if (field.type === "checkbox" && !field.required && Array.isArray(skills)) {
    const compact = (value) => normalize(value).replace(/\s+/g, "");
    if (skills.some((skill) => compact(skill) === compact(field.label))) {
      return { value: true, source: "profile skill" };
    }
  }
  if (field.type === "checkbox" && /\blocations?\b/i.test(field.groupQuestion ?? "")
    && normalize(field.label) === normalize(profileValues.country)) {
    return { value: true, source: "profile" };
  }
  // A generic name or email attribute is not enough when the label identifies
  // another person or organization.
  const unrelated = /company|employer|referr|manager|supervisor|emergency|school|recruiter|contact person/i
    .test(`${field.label} ${field.section}`);
  if (unrelated) return undefined;
  if (/linkedin/i.test(label) && profileValues["linkedin url"]) {
    return { value: profileValues["linkedin url"], source: "profile" };
  }
  const residenceCountry = String(profileValues.country ?? "").trim();
  const namedWorkJurisdiction = String(field.label ?? "")
    .match(/\bwork\s+in\s+([^?.,;]+)/i)?.[1]?.trim();
  const jurisdictionMatches = !namedWorkJurisdiction
    || normalize(namedWorkJurisdiction).includes(normalize(residenceCountry));
  const residenceMentioned = residenceCountry
    && (new RegExp(`\\b${escapePattern(residenceCountry)}\\b`, "i")
      .test(`${opportunity.location ?? ""} ${field.label}`)
      || (profileValues["__residence country code"]
        && new RegExp(`\\b${profileValues["__residence country code"]}\\b`)
          .test(String(opportunity.location ?? ""))));
  if (/authoriz(?:ed|ation).*work/i.test(label)
    && jurisdictionMatches && residenceMentioned
    && profileValues["__residence work authorization"] !== undefined) {
    return { value: profileValues["__residence work authorization"], source: "verified profile fact" };
  }
  if (/visa sponsorship|require sponsorship/i.test(label)
    && profileValues["__visa sponsorship required"] !== undefined) {
    return { value: profileValues["__visa sponsorship required"], source: "verified profile fact" };
  }
  const fileHint = normalize([field.label, field.name, field.id].filter(Boolean).join(" "));
  if (field.type === "file" && /\b(?:resume|cv)\b/.test(fileHint) && profileValues.resume) {
    return { value: profileValues.resume, source: "profile" };
  }
  if (field.type === "file" && /\bcover letter\b/.test(fileHint) && profileValues["cover letter"]) {
    return { value: profileValues["cover letter"], source: "profile" };
  }
  // Profile links are URLs. Never pass one to a file chooser just because its
  // label (for example, "Portfolio") matches an optional upload control.
  if (field.type === "file") return undefined;
  // Generic profile answers have no employer, role, or authorship scope.
  // Narrative questions can also be single-line text inputs on some forms.
  // They need an application-specific answer, reviewed draft, or scoped record.
  if (field.tag === "textarea" || NARRATIVE_QUESTION.test(field.label)) return undefined;
  const normalizedCandidates = new Set(candidates.map(normalize));
  for (const [key, value] of Object.entries(profileValues)) {
    if (value !== undefined && value !== "" && (label === key || normalizedCandidates.has(key))) {
      if ((key.includes("email") || key === "e mail") && field.type !== "email"
        && field.type !== "text") continue;
      if (["resume", "cv", "cover letter"].includes(key) && field.type !== "file") continue;
      return { value, source: key.includes("password") || key === "username" || key === "user name" ? "credential vault" : "profile" };
    }
  }
  return undefined;
}

async function describe(locator) {
  return locator.evaluate((element) => {
    const explicit = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
    const wrapping = element.closest("label");
    const label = element.getAttribute("aria-label")
      || explicit?.innerText || wrapping?.innerText || element.getAttribute("placeholder")
      || element.getAttribute("name") || element.id || "Unlabelled field";
    return {
      id: element.id,
      name: element.getAttribute("name") ?? "",
      label: label.trim().replace(/\s+/g, " "),
      tag: element.tagName.toLowerCase(),
      type: (element.getAttribute("type") ?? "text").toLowerCase(),
      required: element.required || element.getAttribute("aria-required") === "true",
      disabled: element.disabled,
      readOnly: element.readOnly,
      options: element.tagName === "SELECT"
        ? [...element.options].filter((option) => option.value).map((option) => ({ value: option.value, label: option.text.trim() }))
        : []
    };
  });
}

async function fillControl(locator, field, value, surface) {
  if (field.type === "file") {
    const file = { name: path.basename(String(value)), size: (await stat(String(value))).size };
    const host = new URL(surface.url()).hostname;
    const isAshby = host === "jobs.ashbyhq.com";
    const isGreenhouse = ["job-boards.greenhouse.io", "job-boards.eu.greenhouse.io",
      "boards.greenhouse.io", "boards.eu.greenhouse.io"].includes(host);
    const rootPage = typeof surface.page === "function" ? surface.page() : surface;
    const greenhouseResume = isGreenhouse && field.id === "resume"
      && await locator.evaluate((element) =>
        element.closest('.file-upload[role="group"]')?.getAttribute("aria-labelledby")
          === "upload-label-resume").catch(() => false);
    await locator.setInputFiles(String(value));
    if (greenhouseResume) {
      // Greenhouse uploads to S3 before replacing this input with a success
      // chip. Selecting a local file alone is not an upload acknowledgement.
      await rootPage.waitForFunction(greenhouseResumeUploaded, { name: file.name, formIndex: -1 },
        { timeout: 20_000 });
    }
    if (isAshby) {
      // Ashby's GraphQL operation name has changed over time, so binding the
      // upload to one request payload creates a slow false failure. Trust the
      // stable user-visible evidence instead: the selected file remains on a
      // live input, or Ashby replaces the input with the uploaded filename.
      await rootPage.waitForFunction((expected) =>
        document.body?.innerText?.includes(expected)
          || [...document.querySelectorAll('input[type="file"]')]
            .some((input) => [...(input.files ?? [])].some((item) => item.name === expected)),
      file.name, { timeout: 8_000 });
    }
    return { uploadAcknowledged: true, files: [file], greenhouseResume };
  } else if (field.tag === "select") {
    const desired = normalize(value);
    const option = field.options.find((item) => normalize(item.label) === desired || normalize(item.value) === desired);
    if (!option) throw new Error(`answer does not match an option for ${field.label}`);
    await locator.selectOption(option.value);
  } else if (field.type === "checkbox") {
    const checked = value === true || normalize(value) === "yes" || normalize(value) === "true";
    if (await locator.isVisible()) {
      if (checked) await locator.check();
      else await locator.uncheck();
    } else {
      // Some ATSes hide the native control and render a styled label. A DOM
      // click still dispatches the native input/change events their models use.
      await locator.evaluate((element, desired) => {
        if (element.checked !== desired) element.click();
      }, checked);
    }
  } else if (field.type === "radio") {
    const radios = surface.locator('input[type="radio"]');
    const desired = normalize(value);
    for (let index = 0; index < await radios.count(); index += 1) {
      const candidate = radios.nth(index);
      if ((await candidate.getAttribute("name")) !== field.name) continue;
      const candidateField = await describe(candidate);
      const candidateValue = await candidate.getAttribute("value");
      if (normalize(candidateField.label).includes(desired) || normalize(candidateValue) === desired) {
        if (await candidate.isVisible()) await candidate.check();
        else await candidate.evaluate((element) => element.click());
        return;
      }
    }
    throw new Error(`answer does not match a radio option for ${field.label}`);
  } else if (field.tag === "input" && await locator.getAttribute("role") === "combobox") {
    await locator.fill(String(value));
    const desired = normalize(value);
    await locator.press("ArrowDown").catch(() => undefined);
    const options = surface.locator('[role="option"]:visible');
    await options.first().waitFor({ state: "visible", timeout: 1500 }).catch(() => undefined);
    let selected = false;
    for (let index = 0; index < await options.count(); index += 1) {
      const option = options.nth(index);
      const text = normalize(await option.innerText().catch(() => ""));
      if (text !== desired && !text.startsWith(`${desired} `)) continue;
      await option.click();
      await locator.evaluate((element, answer) => {
        const shell = element.closest(".select-shell") ?? element;
        const visual = shell.querySelector(".select__single-value")?.innerText?.trim().replace(/\s+/g, " ")
          || element.value;
        shell.dataset.jobApplicationVerifiedAnswer = String(answer);
        shell.dataset.jobApplicationVerifiedVisual = visual;
      }, value).catch(() => undefined);
      selected = true;
      break;
    }
    if (!selected) throw new Error(`answer does not match a combobox option for ${field.label}`);
  } else {
    await locator.fill(String(value));
  }
}

export function greenhouseResumeUploaded({ name, formIndex }) {
  const groups = [...document.querySelectorAll(
    '.file-upload[role="group"][aria-labelledby="upload-label-resume"]')]
    .filter((group) => formIndex < 0 || group.closest("form") === document.forms[formIndex]);
  if (groups.length !== 1) return false;
  const group = groups[0];
  const label = group.querySelector("#upload-label-resume");
  if (!/^Resume(?:\/CV)?\s*\*?$/i.test(label?.textContent?.trim() ?? "")) return false;
  if (group.querySelector('input[type="file"], [role="progressbar"], .helper-text--error')) return false;
  const chips = [...group.querySelectorAll(".file-upload__filename")];
  if (chips.length !== 1) return false;
  const chip = chips[0];
  if (!chip.getClientRects().length || getComputedStyle(chip).visibility === "hidden") return false;
  const remove = chip.querySelector('button[aria-label="Remove file"]');
  if (!remove) return false;
  const copy = chip.cloneNode(true);
  copy.querySelectorAll("button, svg").forEach((element) => element.remove());
  return copy.textContent?.trim().replace(/\s+/g, " ") === name;
}

const CONTROL_SELECTOR = "input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select";

export async function inventoryFormStep(page) {
  return page.locator(CONTROL_SELECTOR).evaluateAll((elements) => elements.map((element, index) => {
    const form = element.closest("form");
    const visible = (node) => {
      for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (current.hidden || style.display === "none" || style.visibility === "hidden") return false;
      }
      return true;
    };
    // These controls are planned and verified by the Ashby adapter. Including
    // their backing inputs here would mislabel custom selections as raw inputs.
    const ashbyEntry = element.closest(".ashby-application-form-field-entry");
    if (element.closest(".ashby-application-form-input-radio-group")
      || element.closest(".ashby-application-form-autofill-input-root")
      || element.getAttribute("aria-hidden") === "true"
      || ashbyEntry && (element.matches('[role="combobox"]')
        || element.closest(".ashby-application-form-input-yesno"))) return null;
    if (element.type === "file" ? !visible(form ?? element.parentElement) : !visible(element)) return null;
    const labels = [...(element.labels ?? [])].map((label) => label.innerText.trim()).filter(Boolean);
    const ariaLabelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText?.trim()).filter(Boolean).join(" ");
    const stableLabel = element.getAttribute("aria-label") || ariaLabelledBy || labels.join(" ")
      || element.getAttribute("placeholder") || element.getAttribute("name") || element.id;
    if (!stableLabel || element.matches('.iti__search-input, [id^="iti-"][type="search"]')) return null;
    const rawLabel = stableLabel;
    const ashbySection = element.closest(".ashby-application-form-section-container");
    const firstAshbyField = ashbySection?.querySelector(".ashby-application-form-field-entry");
    const sectionLead = firstAshbyField
      ? ashbySection.innerText.split(firstAshbyField.innerText)[0].trim() : "";
    const section = element.closest("fieldset")?.querySelector("legend")?.innerText?.trim()
      .replace(/\s+/g, " ")
      ?? ashbySection?.querySelector("h1,h2,h3,h4")?.innerText?.trim() ?? "";
    const tag = element.tagName.toLowerCase();
    const minimumWords = tag === "textarea"
      ? Number(sectionLead.match(/(?:no less than|at least|minimum(?: of)?)\s+(\d+)\s+words?/i)?.[1] ?? 0)
      : 0;
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    const groupQuestion = ["radio", "checkbox"].includes(type) ? section : "";
    const label = type === "radio" && groupQuestion ? groupQuestion : rawLabel;
    const visuallyRequired = (value) => /\brequired\b/i.test(value)
      || /(?:^|\s)\*(?:\s|$)/.test(value);
    const groupRequired = Boolean(groupQuestion && visuallyRequired(groupQuestion));
    const required = element.required || element.getAttribute("aria-required") === "true"
      || visuallyRequired(rawLabel) || type === "radio" && groupRequired;
    const options = tag === "select"
      ? [...element.options].filter((option) => option.value).map((option) => ({ value: option.value, label: option.text.trim() }))
      : [];
    return {
      index, id: element.id, name: element.getAttribute("name") ?? "",
      label: label.replace(/\s+/g, " ").trim(), tag, type, required,
      groupQuestion, groupRequired,
      disabled: element.disabled, readOnly: element.readOnly,
      options, maxLength: element.maxLength >= 0 ? element.maxLength : null,
      pattern: element.getAttribute("pattern"), autocomplete: element.getAttribute("autocomplete"),
      placeholder: element.getAttribute("placeholder"),
      section, minimumWords,
      formIndex: form ? [...document.forms].indexOf(form) : -1
    };
  }).filter(Boolean));
}

async function readControl(locator, field) {
  return locator.evaluate((element) => {
    if (element.type === "file") return [...(element.files ?? [])].map((file) => ({
      name: file.name, size: file.size
    }));
    if (element.type === "checkbox") return element.checked;
    if (element.type === "radio") {
      const group = [...document.querySelectorAll('input[type="radio"]')]
        .filter((item) => item.name === element.name && item.form === element.form);
      const selected = group.find((item) => item.checked);
      if (!selected) return "";
      const label = selected.id ? document.querySelector(`label[for="${CSS.escape(selected.id)}"]`) : null;
      return (label?.innerText || selected.closest("label")?.innerText || selected.value || "")
        .trim().replace(/\s+/g, " ");
    }
    if (element.getAttribute("role") === "combobox") {
      const shell = element.closest(".select-shell") ?? element;
      const answer = shell.dataset.jobApplicationVerifiedAnswer;
      const expectedVisual = shell.dataset.jobApplicationVerifiedVisual;
      const visual = shell.querySelector(".select__single-value")?.innerText?.trim().replace(/\s+/g, " ")
        || element.value;
      if (answer && visual === expectedVisual) return answer;
      return visual;
    }
    return element.value;
  });
}

async function detachedFileLiveMatch(surface, action, field) {
  if (!Array.isArray(field.files) || field.files.length !== 1
    || field.files[0].name !== field.value || !Number.isInteger(field.files[0].size)
    || field.files[0].size <= 0) return null;
  const formIndex = await action.locator.evaluate((element) => {
    const form = element.form ?? element.closest("form");
    return form ? [...document.forms].indexOf(form) : -1;
  }).catch(() => -1);
  const inputs = await surface.locator('input[type="file"]').evaluateAll((elements, index) =>
    elements.map((element, controlIndex) => ({ element, controlIndex }))
      .filter(({ element }) => !element.disabled
        && (index < 0 || element.form === document.forms[index]))
      .map(({ element, controlIndex }) => ({ controlIndex,
        files: [...(element.files ?? [])].map((file) => ({ name: file.name, size: file.size }))
      })), formIndex).catch(() => null);
  if (!inputs) return null;
  const matches = inputs.filter(({ files }) => files.length === 1
    && files[0].name === field.files[0].name
    && files[0].size === field.files[0].size);
  const host = new URL(surface.url()).hostname;
  const greenhouseResume = field.greenhouseResume === true && field.key === "resume" && field.uploadAcknowledged
    && ["job-boards.greenhouse.io", "job-boards.eu.greenhouse.io",
      "boards.greenhouse.io", "boards.eu.greenhouse.io"].includes(host)
    && await (typeof surface.page === "function" ? surface.page() : surface)
      .evaluate(greenhouseResumeUploaded, { name: field.files[0].name, formIndex })
      .catch(() => false);
  return { inputCount: inputs.length, matches: matches.map((item) => item.controlIndex),
    greenhouseResume };
}

async function controlMatches(locator, field, answer, observed) {
  const expected = field.type === "file" ? path.basename(String(answer.value))
    : field.type === "checkbox" ? Boolean(answer.value === true || normalize(answer.value) === "yes"
      || normalize(answer.value) === "true")
      : field.type === "radio" ? normalize(answer.value) : String(answer.value);
  if (field.type === "file") {
    const size = (await stat(String(answer.value))).size;
    return size > 0 && observed.length === 1
      && observed[0].name === expected && observed[0].size === size;
  }
  if (field.type === "checkbox") return observed === expected;
  if (field.type === "tel") return String(observed).replace(/\D/g, "") === String(expected).replace(/\D/g, "");
  if (field.type === "radio") {
    const value = await locator.evaluate((element) =>
      [...document.querySelectorAll('input[type="radio"]')]
        .find((item) => item.name === element.name && item.form === element.form && item.checked)?.value ?? "");
    return normalize(observed) === expected || normalize(value) === expected;
  }
  if (field.tag === "select") return field.options.some((option) => option.value === observed
    && (normalize(option.label) === normalize(answer.value) || normalize(option.value) === normalize(answer.value)));
  if (field.tag === "input" && await locator.getAttribute("role") === "combobox") {
    const actual = normalize(observed);
    const desired = normalize(expected);
    return actual === desired || actual.startsWith(`${desired} `);
  }
  return observed === expected;
}

function inventoryStamp(fields) {
  return JSON.stringify(fields.map((field) => [field.index, field.formIndex,
    field.name, field.id, field.label, field.type, field.required, field.minimumWords]));
}

export async function fillVisibleFields(page, profile, opportunity, answers, preparedAnswers = {}) {
  const controls = page.locator(CONTROL_SELECTOR);
  const inventory = await inventoryFormStep(page);
  const profileValues = flattenProfile(profile, page.url());
  const unresolved = [];
  const fields = [];
  const sameInventory = (current) => inventoryStamp(current) === inventoryStamp(inventory);
  const changedPlan = () => ({ unresolved, fields, inventory, signature: null, formChanged: true });
  const seenRadioGroups = new Set();
  // Resolve the complete step from one DOM snapshot before changing any value.
  // Later readback is deliberately separate from this answer plan.
  const answerPlan = { version: 1, entries: [] };
  for (const field of inventory) {
    if (field.disabled || field.readOnly) continue;
    if (field.type === "radio" && seenRadioGroups.has(field.name)) continue;
    if (field.type === "radio") seenRadioGroups.add(field.name);
    // A required checkbox is usually a declaration. Stored profile defaults must
    // never silently attest it; only an answer approved for this application may.
    const answer = field.type === "checkbox" && field.required
      ? resolveAnswer(field, answers, {})
      : resolveAnswer(field, answers, profileValues, preparedAnswers,
        Array.isArray(profile.approvedAnswers) ? profile.approvedAnswers : [], opportunity, profile.skills, profile);
    answerPlan.entries.push({ field, answer });
  }
  for (const { field, answer } of answerPlan.entries) {
    if (!sameInventory(await inventoryFormStep(page))) return changedPlan();
    const locator = controls.nth(field.index);
    if (field.minimumWords > 0 && answer?.value !== undefined && answer.value !== "") {
      const words = String(answer.value).trim().split(/\s+/).filter(Boolean).length;
      if (words < field.minimumWords) {
        unresolved.push({ key: field.name || field.id || normalize(field.label),
          label: field.label, required: field.required, type: field.type, tag: field.tag,
          section: field.section, minimumWords: field.minimumWords,
          options: field.options, manualOnly: true,
          problem: `Answer has ${words} words; this section requires at least ${field.minimumWords}` });
        fields.push(fieldSummary(field, undefined, await readControl(locator, field)));
        continue;
      }
    }
    if (!answer || answer.value === undefined || answer.value === "") {
      let observed;
      try { observed = await readControl(locator, field); }
      catch (error) {
        if (!sameInventory(await inventoryFormStep(page))) return changedPlan();
        unresolved.push({ key: field.name || field.id || normalize(field.label), label: field.label,
          required: field.required, type: field.type, problem: error.message });
        fields.push(fieldSummary(field, undefined, undefined));
        continue;
      }
      const prefilled = Array.isArray(observed) ? observed.length > 0
        : typeof observed === "boolean" ? observed : String(observed ?? "").trim() !== "";
      fields.push(fieldSummary(field,
        prefilled ? { value: observed, source: "unverified site prefill" } : undefined, observed));
      if (field.required || prefilled || highValueOptionalProseField(field)) {
        const options = field.type === "radio" ? await radioOptions(page, field.name) : field.options;
        unresolved.push({
          key: field.name || field.id || normalize(field.label),
          label: field.label,
          required: field.required,
          type: field.type === "file" ? "file" : field.tag === "select" ? "select" : field.type,
          tag: field.tag, section: field.section, maxLength: field.maxLength,
          minimumWords: field.minimumWords, options,
          ...(prefilled ? { problem: "an unverified value is already present" } : {})
        });
      }
      continue;
    }
    let fillEvidence;
    try {
      const existing = await readControl(locator, field).catch(() => undefined);
      if (existing !== undefined && await controlMatches(locator, field, answer, existing)) {
        fields.push(fieldSummary(field, answer, existing));
        continue;
      }
      fillEvidence = await fillControl(locator, field, answer.value, page);
      let observed;
      try { observed = await readControl(locator, field); }
      catch (error) {
        if (field.type !== "file") throw error;
        if (!fillEvidence?.uploadAcknowledged) throw error;
        observed = fillEvidence.files;
      }
      if (field.type === "file" && !observed.length && fillEvidence?.uploadAcknowledged) {
        observed = fillEvidence.files;
      }
      let validity;
      try {
        validity = await locator.evaluate((element) => ({ valid: element.validity?.valid ?? true,
          problem: element.validationMessage ?? "" }));
      } catch (error) {
        if (field.type !== "file") throw error;
        validity = { valid: true, problem: "" };
      }
      const matches = await controlMatches(locator, field, answer, observed);
      if (!matches || !validity.valid) throw new Error(validity.problem || "live value did not match the planned answer");
      fields.push({ ...fieldSummary(field, answer, observed),
        ...(fillEvidence?.uploadAcknowledged ? { uploadAcknowledged: true } : {}),
        ...(fillEvidence?.greenhouseResume ? { greenhouseResume: true } : {}) });
    } catch (error) {
      if (field.type === "file" && fillEvidence?.uploadAcknowledged) {
        fields.push({ ...fieldSummary(field, answer, fillEvidence.files), uploadAcknowledged: true,
          ...(fillEvidence.greenhouseResume ? { greenhouseResume: true } : {}) });
        if (!sameInventory(await inventoryFormStep(page))) return changedPlan();
      }
      if (!sameInventory(await inventoryFormStep(page))) return changedPlan();
      unresolved.push({
        key: field.name || field.id || normalize(field.label), label: field.label,
        required: field.required,
        type: field.type, tag: field.tag, section: field.section,
        maxLength: field.maxLength, options: field.options, problem: error.message
      });
      fields.push(fieldSummary(field, undefined, await readControl(locator, field)));
    }
  }
  const checkboxGroups = new Map(inventory.filter((field) => field.type === "checkbox"
    && field.groupQuestion && field.groupRequired).map((field) => [field.name, field]));
  for (const [name, representative] of checkboxGroups) {
    const group = inventory.filter((field) => field.type === "checkbox" && field.name === name);
    const selected = [];
    for (const field of group) {
      if (await readControl(controls.nth(field.index), field)) selected.push(field.label);
    }
    if (!selected.length) unresolved.push({
      key: name || normalize(representative.groupQuestion), label: representative.groupQuestion,
      required: true, type: "checkbox", tag: "input", section: representative.section,
      maxLength: null, options: group.map((field) => ({ value: field.label, label: field.label }))
    });
  }
  const signature = createHash("sha256").update(JSON.stringify({
    origin: new URL(page.url()).origin,
    path: new URL(page.url()).pathname,
    fields: inventory.map((field) => [field.formIndex, field.name, field.id, field.label, field.type, field.required]),
    progress: await page.locator("h1,h2,[aria-current=step],[role=progressbar]").allTextContents()
  })).digest("hex");
  return { unresolved, fields, inventory, signature, answerPlan };
}

function credentialMatches(credential, currentUrl) {
  if (!credential?.origin) return false;
  try { return new URL(credential.origin).hostname === new URL(currentUrl).hostname; }
  catch { return false; }
}

function fieldSummary(field, answer, observed) {
  let value;
  if (answer) {
    if (field.type === "password") value = "[stored securely]";
    else if (field.type === "file") value = observed.map((file) => file.name).join(", ");
    else if (field.type === "checkbox") value = observed ? "Yes" : "No";
    else value = String(observed);
  }
  return {
    key: field.name || field.id || normalize(field.label), label: field.label,
    controlIndex: field.index,
    type: field.type, required: field.required, status: answer ? "filled" : "unfilled",
    ...(answer ? { value, source: answer.source,
      ...(field.type === "file" ? { files: observed,
        stagedPathFingerprint: createHash("sha256").update(String(answer.value)).digest("hex") } : {}),
      ...(field.type === "password" ? { secretFingerprint: createHash("sha256").update(String(observed)).digest("hex") } : {})
    } : {})
  };
}

async function radioOptions(surface, name) {
  const options = [];
  const radios = surface.locator('input[type="radio"]');
  for (let index = 0; index < await radios.count(); index += 1) {
    const candidate = radios.nth(index);
    if ((await candidate.getAttribute("name")) !== name) continue;
    const description = await describe(candidate);
    options.push({ value: await candidate.getAttribute("value"), label: description.label });
  }
  return options;
}

async function inlineValidationQuestions(surface, inventory) {
  const controls = surface.locator(CONTROL_SELECTOR);
  const questions = [];
  for (const field of inventory) {
    if (field.disabled || field.readOnly) continue;
    const problem = await controls.nth(field.index).evaluate((element) => {
      if (element.validity && !element.validity.valid) return element.validationMessage;
      for (const ancestor of [element.parentElement, element.parentElement?.parentElement]) {
        if (!ancestor || ancestor.querySelectorAll('input, textarea, select').length !== 1) continue;
        const nearby = ancestor.querySelector(
          '[role="alert"], [aria-live="assertive"], [class*="text-red"], [class*="error"]'
        );
        if (nearby) return nearby.textContent?.trim() ?? "";
      }
      return "";
    }).catch(() => "");
    if (!problem) continue;
    questions.push({ kind: field.type === "checkbox" ? "legal_attestation" : "missing_answer",
      message: `${field.label}: ${problem.slice(0, 300)}`,
      fields: [field.name || field.id || normalize(field.label)],
      options: field.options.map((option) => ({ ...option, recommended: false })),
      recommendation: "custom" });
  }
  return questions;
}

async function detectChallenge(page) {
  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 50_000);
  // Greenhouse mounts an invisible reCAPTCHA badge on ordinary forms. It is
  // not a human challenge unless the site later opens an interactive frame.
  const challengeFrame = page.frames().some((frame) =>
    frame !== page.mainFrame() && /recaptcha|hcaptcha|turnstile/i.test(frame.url())
      && !(/recaptcha\/[^?]*\/anchor\?/i.test(frame.url())
        && /[?&]size=invisible(?:&|$)/i.test(frame.url())));
  return challengeFrame || CHALLENGE_TEXT.test(body);
}

async function findAction(page) {
  const candidates = page.locator('button:visible:enabled, input[type="submit"]:visible:enabled');
  const actions = [];
  for (let index = 0; index < await candidates.count(); index += 1) {
    const locator = candidates.nth(index);
    const text = (await locator.innerText().catch(() => "")) || (await locator.getAttribute("value")) || "";
    const form = await locator.evaluate((element) => {
      const owner = element.closest("form");
      return owner ? [...document.forms].indexOf(owner) : -1;
    });
    actions.push({ locator, text, form });
  }
  const activeForm = await page.locator("form:visible").evaluateAll((forms) => {
    const selected = forms.find((form) => [...form.querySelectorAll("input,textarea,select")]
      .some((element) => element.getClientRects().length > 0 || element.type === "file"));
    return selected ? [...document.forms].indexOf(selected) : -1;
  });
  const scoped = activeForm >= 0 ? actions.filter((item) => item.form === activeForm) : actions;
  const unique = (items, final) => {
    if (items.length === 1) return { locator: items[0].locator, text: items[0].text, final };
    if (items.length > 1) {
      const sameAction = items.every((item) => item.form === items[0].form
        && normalize(item.text) === normalize(items[0].text));
      if (sameAction) return { locator: items[0].locator, text: items[0].text, final };
      return { ambiguous: true, text: items.map((item) => item.text).join(" / ") };
    }
    return null;
  };
  // A landing-page Apply action takes precedence over unrelated page forms.
  const starts = actions.filter((item) => START_BUTTON.test(item.text));
  if (starts.length && activeForm < 0) return unique(starts, false);
  const next = scoped.filter((item) => NEXT_BUTTON.test(item.text));
  if (next.length) return unique(next, false);
  const auth = scoped.filter((item) => AUTH_BUTTON.test(item.text));
  if (auth.length) return unique(auth, false);
  const finals = scoped.filter((item) => FINAL_BUTTON.test(item.text));
  if (finals.length) return unique(finals, true);
  if (starts.length) return unique(starts, false);
  const links = page.locator('a:visible');
  for (let index = (await links.count()) - 1; index >= 0; index -= 1) {
    const locator = links.nth(index);
    const text = await locator.innerText().catch(() => "");
    if (START_BUTTON.test(text)) return { locator, final: false, text };
  }
  for (let index = (await links.count()) - 1; index >= 0; index -= 1) {
    const locator = links.nth(index);
    const text = await locator.innerText().catch(() => "");
    if (AUTH_BUTTON.test(text)) return { locator, final: false, text };
  }
  return null;
}

export async function captureReceipt(page, artifactsDirectory, applicationId) {
  await mkdir(artifactsDirectory, { recursive: true });
  const screenshot = path.join(artifactsDirectory, `${applicationId}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  const screenshotSha256 = createHash("sha256").update(await readFile(screenshot)).digest("hex");
  return {
    submittedAt: new Date().toISOString(),
    finalUrl: page.url(),
    screenshot,
    screenshotSha256,
    simulated: false
  };
}

async function activeSurface(page) {
  const mainAction = await findAction(page);
  if (mainAction && START_BUTTON.test(mainAction.text ?? "")) return page;
  if ((await inventoryFormStep(page)).length && mainAction) return page;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const visible = await frame.frameElement().then((element) => element.isVisible()).catch(() => false);
    if (!visible) continue;
    const fields = await inventoryFormStep(frame).catch(() => []);
    if (fields.length && await findAction(frame).catch(() => null)) return frame;
  }
  return page;
}

export function unavailablePostingUrl(value) {
  try {
    const url = new URL(value);
    return /(?:^|\.)job-boards\.greenhouse\.io$/i.test(url.hostname)
      && url.searchParams.get("error") === "true";
  } catch { return false; }
}

export async function automateApplication({ page, profile, opportunity, application, artifactsDirectory,
  evidencePacket, draftProvider, claimReviewer, markFinalActionStarted, authorizeFinal, commitFinal }) {
  const attemptStarted = performance.now();
  const timings = { loadMs: 0, planFillMs: 0, draftMs: 0, transitionMs: 0, receiptMs: 0, steps: 0,
    fields: 0, draftCalls: 0 };
  const initialResponse = await page.goto(opportunity.applyUrl,
    { waitUntil: "domcontentloaded", timeout: 45_000 });
  if ([403, 429].includes(initialResponse?.status())) {
    return { status: "needs_human", phase: "before_final_action",
      message: `The employer returned HTTP ${initialResponse.status()} before the application opened`,
      requirements: [{ kind: "access_restricted", action: "manual_review",
        message: "Stop this source and inspect its access restriction before any retry" }] };
  }
  // React-based ATS pages can finish DOMContentLoaded before the application
  // controls are mounted. Wait for a real control so the first inspection does
  // not incorrectly classify a supported form as empty.
  await page.locator("input, textarea, select, button, iframe").first()
    .waitFor({ state: "attached", timeout: 10_000 }).catch(() => undefined);
  const surfaceDeadline = Date.now() + 10_000;
  while (Date.now() < surfaceDeadline) {
    if (await findAction(page).catch(() => null)) break;
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(150);
  timings.loadMs = performance.now() - attemptStarted;
  const observedFields = new Map();
  const visitedSteps = new Set();
  let surface = page;
  const draftFingerprint = draftContextFingerprint(profile, opportunity, evidencePacket,
    application.answers ?? {});
  const preparedAnswers = application.preparedAnswers?.__contextFingerprint === draftFingerprint
    ? { ...application.preparedAnswers } : {};
  preparedAnswers.__contextFingerprint = draftFingerprint;
  const pause = (result, step, phase = "before_final_action") => ({
    ...result, phase, preparedAnswers,
    metrics: { ...timings, activeMs: performance.now() - attemptStarted },
    checkpoint: {
      version: 1, applicationId: application.id, step,
      origin: new URL(surface.url()).origin,
      steps: [...new Map([...observedFields.values()].map((field) => [field.step,
        { index: field.step, signature: field.stepSignature }])).values()],
      fields: [...observedFields.values()].slice(0, 200).map((field) => ({
        step: field.step, key: field.key, label: field.label,
        status: field.status, source: field.source
      }))
    }
  });
  // Account creation plus a multi-page application can legitimately exceed
  // eight transitions while remaining bounded and reviewable.
  for (let step = 0; step < 16; step += 1) {
    timings.steps = step + 1;
    surface = await activeSurface(page);
    if (step === 0 && unavailablePostingUrl(surface.url())) {
      return pause({ status: "posting_unavailable", reasonCode: "posting_not_found",
        message: "The employer redirected this expired role to its job board" }, step);
    }
    const landingAction = await findAction(surface);
    if (landingAction?.ambiguous) return pause({
      status: "needs_human", message: "Multiple competing application actions were found",
      requirements: [{ kind: "ambiguous_action", action: "manual_review", message: landingAction.text }]
    }, step);
    if (step === 0 && landingAction && !landingAction.final && START_BUTTON.test(landingAction.text)
      && !/\/(?:apply|application)(?:\/|$)/i.test(new URL(surface.url()).pathname)) {
      const pagesBeforeClick = new Set(page.context().pages());
      const priorBody = await surface.locator("body").innerText().catch(() => "");
      await landingAction.locator.click({ noWaitAfter: true });
      await waitForStepChange(surface, priorBody);
      const popup = page.context().pages().find((candidate) => !pagesBeforeClick.has(candidate));
      if (popup) page = popup;
      await surface.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      await waitForInventoryStability(surface);
      continue;
    }
    if (await openSignupForGeneratedCredential(surface, profile.siteCredential)) continue;
    const unsupportedControls = await surface.locator(
      'form:visible [contenteditable="true"], form:visible [role="combobox"]:not(input):not(select), form:visible [role="textbox"]:not(input):not(textarea)'
    ).count().catch(() => 0);
    if (unsupportedControls) return pause({
      status: "needs_human", message: "The application contains an unsupported custom control",
      requirements: [{ kind: "unsupported_control", action: "manual_review",
        message: "Inspect the custom form control before submission" }]
    }, step);
    const custom = await fillAshbyRequiredControls(surface, profile, application.answers ?? {});
    const planStarted = performance.now();
    let { unresolved, fields, signature, inventory, formChanged } = await fillVisibleFields(
      surface, profile, opportunity, application.answers ?? {}, preparedAnswers
    );
    const retainedFilledFields = new Map(fields.filter((field) => field.status === "filled")
      .map((field) => [`${field.key}:${field.label}`, field]));
    for (let pass = 0; pass < 12; pass += 1) {
      const current = await inventoryFormStep(surface);
      if (!formChanged && inventoryStamp(current) === inventoryStamp(inventory)) break;
      ({ unresolved, fields, signature, inventory, formChanged } = await fillVisibleFields(
        surface, profile, opportunity, application.answers ?? {}, preparedAnswers
      ));
      for (const field of fields.filter((item) => item.status === "filled")) {
        retainedFilledFields.set(`${field.key}:${field.label}`, field);
      }
    }
    if (formChanged || inventoryStamp(await inventoryFormStep(surface)) !== inventoryStamp(inventory)) {
      return pause({ status: "needs_human", message: "The application form kept changing during entry",
      requirements: [{ kind: "unstable_form", action: "manual_review",
        message: "Inspect the current form before continuing" }] }, step);
    }
    const currentFieldKeys = new Set(fields.map((field) => `${field.key}:${field.label}`));
    for (const [key, field] of retainedFilledFields) {
      if (!currentFieldKeys.has(key)) fields.push({ ...field, detached: true });
    }
    timings.planFillMs += performance.now() - planStarted;
    timings.fields += inventory.length;
    const prose = unresolved.filter((field) => !field.manualOnly && eligibleProseField(field));
    const humanAuthorshipRestriction = /\b(?:no ai|without ai|human.?written|do not use ai)\b/i.test(
      `${opportunity.description ?? ""} ${await surface.locator("body").innerText().catch(() => "")}`
    );
    if (humanAuthorshipRestriction && fields.some((field) => field.source === "drafted prose"
      || String(field.source ?? "").startsWith("approved answer:"))) {
      return pause({ status: "needs_human", message: "The employer requires human-written application answers",
        requirements: [{ kind: "human_authorship", action: "manual_review",
          message: "Verify the exact applicant-written answer for this form" }] }, step);
    }
    if (prose.length && draftProvider) {
      if (humanAuthorshipRestriction) return pause({ status: "needs_human", message: "The employer requires human-written application answers",
        requirements: [{ kind: "human_authorship", action: "manual_review",
          message: "Write these answers without automated drafting" }] }, step);
      const research = prose.filter((field) => needsCompanyResearch(field, evidencePacket));
      if (research.length) return pause({
        status: "needs_research", message: "Official company context is needed for these questions",
        questions: research.map((field) => ({ fieldId: field.key, question: field.label }))
      }, step);
      if (!claimReviewer) return pause({ status: "needs_human",
        message: "New application prose requires an independent claim review",
        requirements: [{ kind: "prose_claim_review", action: "manual_review",
          message: "Review the answer against verified applicant and employer evidence" }] }, step);
      const questions = prose.map((field) => ({
        fieldId: field.key, question: field.label, maxLength: field.maxLength,
        minimumWords: field.minimumWords
      }));
      let drafts;
      const draftStarted = performance.now();
      timings.draftCalls += 1;
      try { drafts = await draftProvider.draft({ questions, evidencePacket }); }
      catch (error) { return pause({ status: "needs_human", message: "Prose drafting could not finish",
        requirements: [{ kind: "draft_provider_failed", action: "manual_review",
          message: String(error.message).slice(0, 300) }] }, step); }
      timings.draftMs += performance.now() - draftStarted;
      const wanted = new Map(questions.map((question) => [question.fieldId, question]));
      const allowedEvidence = new Set(["listing", "applicant:skills",
        ...(evidencePacket?.research ?? []).map((_, index) => `research:${index}`),
        ...(evidencePacket?.applicant?.examples ?? []).map((item) => `applicant:example:${item.id}`)]);
      for (const draft of drafts) {
        const question = wanted.get(draft.fieldId);
        if (question && draft.insufficientEvidence === true) {
          if (companyQuestion(question.question)) return pause({ status: "needs_research",
            message: "A grounded company answer needs more evidence",
            questions: [{ fieldId: question.fieldId, question: question.question }] }, step);
          return pause({ status: "needs_input", message: "A personal answer needs owner input",
            requirements: [{ kind: "missing_answer", fields: [question.fieldId],
              message: question.question, recommendation: "custom" }] }, step);
        }
        if (!question || typeof draft.text !== "string" || !draft.text.trim()
          || draft.text.length > 5000 || (question.maxLength && draft.text.length > question.maxLength)
          || (question.minimumWords > 0 && draft.text.trim().split(/\s+/).length < question.minimumWords)
          || !Array.isArray(draft.evidenceIds)
          || !draft.evidenceIds.length
          || draft.evidenceIds.some((id) => !allowedEvidence.has(id)
            || id === "listing" && !String(evidencePacket?.listing ?? "").trim()
            || id === "applicant:skills" && !(evidencePacket?.applicant?.skills ?? []).length)) {
          return pause({ status: "needs_input", message: "A prose draft needs owner correction",
            requirements: [{ kind: "missing_answer", fields: [question?.fieldId ?? "prose"],
              message: question?.question ?? "Application prose", recommendation: "custom" }] }, step);
        }
        let review;
        try { review = await claimReviewer.review({ question: question.question,
          text: draft.text, evidenceIds: draft.evidenceIds, evidencePacket }); }
        catch (error) { return pause({ status: "needs_human",
          message: "Independent prose review could not finish",
          requirements: [{ kind: "prose_claim_review", action: "manual_review",
            message: String(error.message).slice(0, 300) }] }, step); }
        if (companyQuestion(question.question) && review.companySpecific !== true) {
          return pause({ status: "needs_research",
            message: "A company-specific answer needs more current employer evidence",
            questions: [{ fieldId: question.fieldId, question: question.question }] }, step);
        }
        if (review.supported !== true || review.responsive !== true
          || !Array.isArray(review.claims) || !review.claims.length
          || review.claims.some((claim) => claim.supported !== true
            || typeof claim.text !== "string" || !claim.text.trim()
            || !draft.text.includes(claim.text)
            || !Array.isArray(claim.evidenceIds) || !claim.evidenceIds.length
            || claim.evidenceIds.some((id) => !allowedEvidence.has(id)))) {
          return pause({ status: "needs_input", message: "A prose claim lacks verified support",
            requirements: [{ kind: "missing_answer", fields: [question.fieldId],
              message: question.question, recommendation: "custom" }] }, step);
        }
        preparedAnswers[draft.fieldId] = draft.text.trim();
      }
      ({ unresolved, fields, signature, inventory } = await fillVisibleFields(
        surface, profile, opportunity, application.answers ?? {}, preparedAnswers
      ));
    }
    if (visitedSteps.has(signature)) {
      const validation = await inlineValidationQuestions(surface, inventory);
      if (validation.length) return pause({ status: "needs_input",
        message: "The application requires corrections before the next step",
        requirements: validation }, step);
      return pause({
        status: "needs_human", message: "The application did not advance after a non-final action",
        requirements: [{ kind: "step_not_advanced", action: "manual_review",
          message: "Inspect validation errors on the current application step" }]
      }, step);
    }
    visitedSteps.add(signature);
    for (const field of fields) observedFields.set(`${step}:${signature}:${field.key}:${field.label}`, {
      ...field, step, stepSignature: signature
    });
    for (const field of custom.fields) observedFields.set(`${step}:${signature}:${field.key}:${field.label}`, {
      ...field, step, stepSignature: signature
    });
    if (await detectChallenge(page)) {
      return pause({
        status: "needs_human",
        message: "The application site presented a human verification challenge",
        requirements: [{ kind: "human_challenge", action: "manual_review", message: "Complete or inspect the browser challenge" }]
      }, step);
    }
    if (custom.requirements.length) return pause({ status: "needs_input",
      message: "Required custom application questions need review",
      requirements: custom.requirements }, step);
    if (unresolved.length) {
      const verification = unresolved.find((field) => VERIFICATION_FIELD.test(`${field.key} ${field.label}`));
      if (verification) {
        return pause({
          status: "needs_input", message: "The site requires account verification",
          requirements: [{ kind: "authentication_verification", message: verification.label,
            fields: [verification.key], options: verification.options, recommendation: "custom" }]
        }, step);
      }
      const password = unresolved.find((field) => field.type === "password");
      if (password) {
        const signupAvailable = await hasSignupAction(page);
        return pause({
          status: "needs_input", message: "The job site requires an account credential",
          requirements: [{
            kind: "account_credentials", message: `Credentials are required for ${new URL(page.url()).hostname}`,
            fields: ["siteAccountAction"], origin: new URL(page.url()).origin,
            options: signupAvailable ? [{ label: "Create a managed account", value: "generate", recommended: true }] : [],
            recommendation: signupAvailable ? "generate" : "custom"
          }]
        }, step);
      }
      return pause({
        status: "needs_input",
        message: "Application questions need answers",
        requirements: unresolved.map((field) => ({
          kind: field.type === "checkbox" ? "legal_attestation" : "missing_answer",
          message: field.problem ? `${field.label}: ${field.problem}` : field.label,
          fields: [field.key], options: field.options.map((option) => ({ ...option, recommended: false })),
          recommendation: "custom"
        }))
      }, step);
    }
    const action = await findAction(surface);
    if (action?.ambiguous) {
      return pause({
        status: "needs_human", message: "Multiple competing application actions were found",
        requirements: [{ kind: "ambiguous_action", action: "manual_review", message: action.text }]
      }, step);
    }
    if (!action) {
      const body = await surface.locator("body").innerText().catch(() => "");
      if (await detectChallenge(page)) return pause({ status: "needs_human",
        message: "The application site presented a human verification challenge",
        requirements: [{ kind: "human_challenge", action: "manual_review",
          message: "Complete or inspect the browser challenge" }] }, step);
      if (!inventory.length && /\bJob not found\b\s*The job you requested was not found\./i.test(body)) {
        return pause({ status: "posting_unavailable", reasonCode: "posting_not_found",
          message: "The employer application page says the job was not found" }, step);
      }
      return pause({
        status: "needs_human", message: "No supported application action was found",
        requirements: [{ kind: "unsupported_form", action: "manual_review", message: "Inspect this application form manually" }]
      }, step);
    }
    const previousUrl = surface.url();
    let reviewedLiveState;
    if (action.final) {
      // Controlled ATS fixtures reproduce values that appear filled until a
      // delayed blur/change handler discards them. Trigger that handler, then
      // inspect the form again after its debounce window before any permit.
      await surface.locator("body").evaluate((body) => body.ownerDocument.activeElement?.blur());
      await surface.waitForTimeout(650);
      if (new URL(surface.url()).hostname === "jobs.ashbyhq.com") {
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      }
    }
    const bodyBeforeSubmit = action.final
      ? (await surface.locator("body").innerText().catch(() => "")).slice(0, 50_000)
      : "";
    if (action.final) {
      if (!await verifyAshbyRequiredControls(surface, custom.fields)) return pause({
        status: "needs_input", message: "A custom answer changed before final submission",
        requirements: [{ kind: "final_review_changed", fields: custom.fields.map((field) => field.key),
          message: "Review the custom application answers again before submission" }]
      }, step);
      const current = await inventoryFormStep(surface);
      if (JSON.stringify(current.map((field) => [field.name, field.id, field.label]))
        !== JSON.stringify(inventory.map((field) => [field.name, field.id, field.label]))) {
        return pause({ status: "needs_input", message: "The form changed before final submission",
          requirements: [{ kind: "final_review_changed", fields: [],
            message: "Review the newly changed form before submission" }] }, step);
      }
      const validation = await inlineValidationQuestions(surface, current);
      if (validation.length) return pause({ status: "needs_input",
        message: "The application has field errors before final submission",
        requirements: validation }, step);
      const matchedDetachedFileInputs = new Set();
      for (const field of [...observedFields.values()].filter((item) => item.step === step)) {
        if (field.type === "ashby_custom") continue;
        if (field.detached) {
          if (field.type === "file" && field.status === "filled") {
            const live = await detachedFileLiveMatch(surface, action, field);
            const greenhouseResume = field.greenhouseResume === true && field.key === "resume"
              && /^(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io$/.test(
                new URL(surface.url()).hostname);
            if (greenhouseResume && live?.greenhouseResume) continue;
            if (!greenhouseResume && live?.matches.length === 1
              && !matchedDetachedFileInputs.has(live.matches[0])) {
              matchedDetachedFileInputs.add(live.matches[0]);
              continue;
            }
            if (!greenhouseResume && live?.inputCount === 0 && field.uploadAcknowledged) {
              const body = await surface.locator("body").innerText().catch(() => "");
              if (body.includes(field.value)) continue;
            }
          }
          return pause({ status: "needs_input", message: "A field changed before final submission",
            requirements: [{ kind: "final_review_changed", fields: [field.key],
              message: `Review ${field.label} again before submission` }] }, step);
        }
        const locator = surface.locator(CONTROL_SELECTOR).nth(field.controlIndex);
        const live = await readControl(locator, field);
        const currentValue = field.type === "password" ? "[stored securely]"
          : field.type === "file" ? live.map((file) => file.name).join(", ")
            : field.type === "checkbox" ? live ? "Yes" : "No" : String(live);
        const valid = await locator.evaluate((element) => element.validity?.valid ?? true);
        const changedSecret = field.type === "password"
          && createHash("sha256").update(String(live)).digest("hex") !== field.secretFingerprint;
        const changedFile = field.type === "file" && field.status === "filled"
          && JSON.stringify(live) !== JSON.stringify(field.files);
        const unexpectedValue = field.type === "checkbox" ? live === true
          : field.type === "file" ? live.length > 0 : String(live ?? "").trim() !== "";
        if (!valid || changedSecret || changedFile || (field.status === "filled" ? currentValue !== field.value
          : unexpectedValue)) {
          return pause({ status: "needs_input", message: "A field changed before final submission",
            requirements: [{ kind: "final_review_changed", fields: [field.key],
              message: `Review ${field.label} again before submission` }] }, step);
        }
      }
      reviewedLiveState = await finalLiveState(surface);
      const preview = previewOf(observedFields, surface.url(), opportunity);
      // A fresh ATS render can assign different DOM IDs or reorder hidden
      // backing controls. Approval binds to the reviewed answers and files,
      // while the live readback above checks the current form before Submit.
      const approvedContent = {
        ...preview,
        filled: preview.filled.map(({ controlIndex, stepSignature, ...field }) => field),
        unfilled: preview.unfilled.map(({ controlIndex, stepSignature, ...field }) => field)
      };
      const previewFingerprint = createHash("sha256").update(JSON.stringify({
        preview: approvedContent,
        privateFingerprints: [...observedFields.values()].map((field) => [
          field.step, field.key, field.secretFingerprint, field.stagedPathFingerprint
        ])
      })).digest("hex");
      if ((application.finalApprovalRequired || application.standingPolicyVersion === undefined
        && [...observedFields.values()].some((field) => field.source === "drafted prose"))
        && application.finalSubmissionApproval?.previewFingerprint !== previewFingerprint) {
        return pause({
          status: "needs_input", message: "Review all fields before the final submission",
          requirements: [{
            kind: "final_submission_approval", message: "Ready for your approval before Submit",
            fields: [], preview, previewFingerprint, recommendation: "approve"
          }]
        }, step);
      }
      if (application.standingPolicyVersion !== undefined) {
        if (!authorizeFinal || !commitFinal) return pause({ status: "needs_human",
          message: "The server final-decision gate is unavailable",
          requirements: [{ kind: "final_policy_unavailable", action: "manual_review",
            message: "Review this application before submitting" }] }, step);
        let decision;
        try { decision = await authorizeFinal({ applicationId: application.id,
          attemptId: application.claim?.attemptId, previewFingerprint, preview }); }
        catch { return pause({ status: "needs_human", message: "The final-decision gate failed",
          requirements: [{ kind: "final_policy_unavailable", action: "manual_review",
            message: "Review this application before submitting" }] }, step); }
        if (decision.decision !== "permit") return pause({ status: "needs_input",
          message: "The standing submission policy requires review",
          requirements: [{ kind: "final_policy_hold", action: "manual_review",
            message: (decision.reasonCodes ?? []).join(", ") || "Policy hold", preview,
            previewFingerprint }] }, step);
        application.finalPermit = { permit: decision.permit, previewFingerprint };
      }
    }
    const pagesBeforeClick = new Set(page.context().pages());
    // Sites frequently keep authentication and multi-step transitions entirely
    // client-side. Do not let Playwright's implicit navigation wait consume the
    // whole action timeout; the explicit load-state wait below handles real
    // navigations while DOM-only transitions can continue immediately.
    const priorBody = await surface.locator("body").innerText().catch(() => "");
    const transitionStarted = performance.now();
    const networkEvents = [];
    const networkBodies = [];
    const consoleErrors = [];
    if (action.final) {
      page.on("response", (response) => {
        const url = response.url();
        if (!/ashbyhq\.com|comeet\.co|splitmetrics\.com/.test(url)) return;
        const event = { status: response.status(), method: response.request().method(),
          url: new URL(url).origin + new URL(url).pathname };
        networkEvents.push(event);
        if (event.method === "POST" && event.url.endsWith("/api/non-user-graphql")) {
          networkBodies.push(response.text().then((body) => { event.body = body.slice(0, 4000); })
            .catch(() => undefined));
        }
      });
      page.on("requestfailed", (request) => {
        const url = request.url();
        networkEvents.push({ failed: request.failure()?.errorText, method: request.method(),
          url: new URL(url).origin + new URL(url).pathname });
      });
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
      });
    }
    if (action.final && (!await verifyAshbyRequiredControls(surface, custom.fields)
      || await finalLiveState(surface) !== reviewedLiveState)) {
      return pause({ status: "needs_input", message: "The form changed after final review",
        requirements: [{ kind: "final_review_changed", fields: [],
          message: "Review the changed form before submitting" }] }, step);
    }
    if (action.final && application.finalPermit) {
      try { await commitFinal({ applicationId: application.id,
        attemptId: application.claim?.attemptId, ...application.finalPermit }); }
      catch { return pause({ status: "needs_human", message: "The final submission permit expired or was revoked",
        requirements: [{ kind: "final_policy_revoked", action: "manual_review",
          message: "Review the current policy and form before submitting" }] }, step); }
    }
    if (action.final) await markFinalActionStarted?.();
    await action.locator.click({ noWaitAfter: true });
    if (!action.final) await waitForStepChange(surface, priorBody);
    const popup = page.context().pages().find((candidate) => !pagesBeforeClick.has(candidate));
    if (popup) page = popup;
    if (!action.final) {
      await surface.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      await waitForInventoryStability(surface);
      timings.transitionMs += performance.now() - transitionStarted;
      continue;
    }
    await surface.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    const verified = await waitForSubmissionEvidence(surface, previousUrl, bodyBeforeSubmit);
    timings.receiptMs += performance.now() - transitionStarted;
    if (!verified) {
      await Promise.allSettled(networkBodies);
      await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
      await page.screenshot({ path: path.join(artifactsDirectory, `${application.id}.unverified.png`),
        fullPage: true }).catch(() => undefined);
      const diagnostic = {
        url: surface.url(),
        body: (await surface.locator("body").innerText().catch(() => "")).slice(0, 8000),
        invalid: await surface.locator("input:invalid, textarea:invalid, select:invalid")
          .evaluateAll((elements) => elements.map((element) => ({
            name: element.name, type: element.type, message: element.validationMessage
          }))).catch(() => []),
        visibleForms: await surface.locator("form:visible").count().catch(() => 0),
        networkEvents: networkEvents.slice(-40), consoleErrors: consoleErrors.slice(-20)
      };
      await writeFile(path.join(artifactsDirectory, `${application.id}.unverified.json`),
        JSON.stringify(diagnostic), { mode: 0o600 }).catch(() => undefined);
      if (BLOCKED_SUBMISSION_TEXT.test(diagnostic.body)) {
        return pause({
          status: "needs_human", message: "The employer blocked the submission as possible spam",
          requirements: [{ kind: "submission_blocked", action: "manual_review",
            message: "Ashby flagged this application as possible spam. Continue in a regular browser and verify its outcome." }]
        }, step, "final_action_started");
      }
      return pause({
        status: "needs_human",
        message: "The submit action ran, but the site did not provide a verifiable confirmation",
        requirements: [{ kind: "submission_unverified", action: "manual_review", message: "Check whether the application was received before retrying" }]
      }, step, "final_action_started");
    }
    const receipt = await captureReceipt(page, artifactsDirectory, application.id);
    if (surface !== page) receipt.finalUrl = surface.url();
    receipt.metrics = { ...timings, activeMs: performance.now() - attemptStarted };
    return { status: "submitted", receipt };
  }
  return pause({
    status: "needs_human", message: "The application exceeded the supported number of form steps",
    requirements: [{ kind: "unsupported_form", action: "manual_review", message: "Complete this multi-step application manually" }]
  }, 16);
}

async function finalLiveState(surface) {
  const inventory = await inventoryFormStep(surface);
  const controls = surface.locator(CONTROL_SELECTOR);
  const values = [];
  const validity = [];
  for (const field of inventory) {
    try { values.push(await readControl(controls.nth(field.index), field)); }
    catch { values.push("[control disappeared]"); }
    validity.push(await controls.nth(field.index).evaluate((element) => [
      element.validity?.valid ?? true, element.getAttribute("aria-invalid")
    ]).catch(() => [false, "detached"]));
  }
  const errors = (await inlineValidationQuestions(surface, inventory)).map((item) => [item.kind, item.fields]);
  return JSON.stringify([surface.url(), inventoryStamp(inventory), values, validity, errors]);
}

async function waitForStepChange(page, priorBody) {
  await page.waitForFunction((before) => document.body?.innerText !== before,
    priorBody, { timeout: 1500 }).catch(() => undefined);
}

async function waitForInventoryStability(surface, timeoutMs = 3500) {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let stable = 0;
  while (Date.now() < deadline) {
    const current = inventoryStamp(await inventoryFormStep(surface).catch(() => []));
    if (current !== "[]" && current === previous) stable += 1;
    else stable = 0;
    if (stable >= 2) return;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function previewOf(observedFields, destination, opportunity) {
  const fields = [...observedFields.values()].map(({ secretFingerprint, stagedPathFingerprint, ...field }) => field);
  const url = new URL(destination);
  return {
    destination: `${url.origin}${url.pathname}`, company: opportunity.company, title: opportunity.title,
    filled: fields.filter((field) => field.status === "filled"),
    unfilled: fields.filter((field) => field.status === "unfilled")
  };
}

async function hasSignupAction(page) {
  const candidates = page.locator("a:visible, button:visible");
  for (let index = 0; index < await candidates.count(); index += 1) {
    if (SIGNUP_BUTTON.test(await candidates.nth(index).innerText().catch(() => ""))) return true;
  }
  return false;
}

async function openSignupForGeneratedCredential(page, credential) {
  if (!credential?.generated || !credentialMatches(credential, page.url())) return false;
  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 20_000);
  if (!/sign in|log in/i.test(body)) return false;
  const candidates = page.locator("a:visible");
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (!SIGNUP_BUTTON.test(await candidate.innerText().catch(() => ""))) continue;
    await candidate.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    return true;
  }
  return false;
}
