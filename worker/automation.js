import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const FINAL_BUTTON = /submit(?: application)?|send application|complete application/i;
const NEXT_BUTTON = /next|continue|save and continue|review/i;
const START_BUTTON = /^(?:apply|apply manually)$|apply now|apply for this job|start application/i;
const AUTH_BUTTON = /sign in|log in|create account|register|sign up/i;
const SIGNUP_BUTTON = /create account|register|sign up/i;
const SUCCESS_TEXT = /thank you|application (?:has been |was )?submitted|application received|received your application/i;
const CHALLENGE_TEXT = /captcha|verify you are human|security check|unusual traffic|cloudflare/i;
const VERIFICATION_FIELD = /\b(otp|one.?time|verification code|security code|authenticator|two.?factor|2fa|mfa|passkey)\b/i;

export async function waitForSubmissionEvidence(page, previousUrl, bodyBeforeSubmit, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = page.url();
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 50_000);
    const confirmationUrl = /confirmation|thank|success|submitted/i.test(currentUrl) && currentUrl !== previousUrl;
    const newSuccessText = SUCCESS_TEXT.test(body) && body !== bodyBeforeSubmit;
    if (confirmationUrl || newSuccessText) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function flattenProfile(profile, currentUrl) {
  const contact = profile.contact ?? {};
  const links = profile.links ?? {};
  const documents = profile.documents ?? {};
  const values = {
    "first name": contact.firstName,
    firstname: contact.firstName,
    "given name": contact.firstName,
    "last name": contact.lastName,
    lastname: contact.lastName,
    surname: contact.lastName,
    name: contact.fullName ?? [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    "full name": contact.fullName ?? [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    "first and last name": contact.fullName ?? [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    "your name": contact.fullName ?? [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    email: contact.email,
    "email address": contact.email,
    "your email": contact.email,
    phone: contact.phone,
    "phone number": contact.phone,
    location: contact.location,
    city: contact.city,
    country: contact.country,
    address: contact.address,
    "street address": contact.address,
    "postal code": contact.postalCode,
    postcode: contact.postalCode,
    "zip code": contact.postalCode,
    linkedin: links.linkedin,
    "linkedin profile": links.linkedin,
    github: links.github,
    portfolio: links.portfolio,
    website: links.portfolio,
    resume: documents.resume,
    cv: documents.resume,
    "cover letter": documents.coverLetter,
    ...Object.fromEntries(Object.entries(profile.applicationAnswers ?? {}).map(([key, value]) => [normalize(key), value]))
  };
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

function resolveAnswer(field, answers, profileValues) {
  const candidates = [field.name, field.id, field.label].filter(Boolean);
  for (const candidate of candidates) {
    if (Object.hasOwn(answers, candidate)) return { value: answers[candidate], source: "application answer" };
    const key = normalize(candidate);
    if (Object.hasOwn(answers, key)) return { value: answers[key], source: "application answer" };
  }
  const label = normalize(field.label);
  if (field.type === "file" && /\b(?:resume|cv)\b/.test(label) && profileValues.resume) {
    return { value: profileValues.resume, source: "profile" };
  }
  if (field.type === "file" && /\bcover letter\b/.test(label) && profileValues["cover letter"]) {
    return { value: profileValues["cover letter"], source: "profile" };
  }
  const normalizedCandidates = new Set(candidates.map(normalize));
  for (const [key, value] of Object.entries(profileValues)) {
    if (value !== undefined && value !== "" && (label === key || normalizedCandidates.has(key))) {
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

async function fillControl(locator, field, value) {
  if (field.type === "file") {
    await locator.setInputFiles(String(value));
  } else if (field.tag === "select") {
    const desired = normalize(value);
    const option = field.options.find((item) => normalize(item.label) === desired || normalize(item.value) === desired);
    if (!option) throw new Error(`answer does not match an option for ${field.label}`);
    await locator.selectOption(option.value);
  } else if (field.type === "checkbox") {
    if (value === true || normalize(value) === "yes" || normalize(value) === "true") await locator.check();
    else await locator.uncheck();
  } else if (field.type === "radio") {
    const radios = locator.page().locator('input[type="radio"]');
    const desired = normalize(value);
    for (let index = 0; index < await radios.count(); index += 1) {
      const candidate = radios.nth(index);
      if ((await candidate.getAttribute("name")) !== field.name) continue;
      const candidateField = await describe(candidate);
      const candidateValue = await candidate.getAttribute("value");
      if (normalize(candidateField.label).includes(desired) || normalize(candidateValue) === desired) {
        await candidate.check();
        return;
      }
    }
    throw new Error(`answer does not match a radio option for ${field.label}`);
  } else {
    await locator.fill(String(value));
  }
}

async function fillVisibleFields(page, profile, answers) {
  const controls = page.locator("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select");
  const profileValues = flattenProfile(profile, page.url());
  const unresolved = [];
  const fields = [];
  const seenRadioGroups = new Set();
  for (let index = 0; index < await controls.count(); index += 1) {
    const locator = controls.nth(index);
    const field = await describe(locator);
    if (field.type !== "file" && !(await locator.isVisible())) continue;
    if (field.disabled || field.readOnly) continue;
    if (field.type === "radio" && seenRadioGroups.has(field.name)) continue;
    if (field.type === "radio") seenRadioGroups.add(field.name);
    // A required checkbox is usually a declaration. Stored profile defaults must
    // never silently attest it; only an answer approved for this application may.
    const answer = field.type === "checkbox" && field.required
      ? resolveAnswer(field, answers, {})
      : resolveAnswer(field, answers, profileValues);
    if (!answer || answer.value === undefined || answer.value === "") {
      fields.push(fieldSummary(field));
      if (field.required) {
        const options = field.type === "radio" ? await radioOptions(locator, field.name) : field.options;
        unresolved.push({
          key: field.name || field.id || normalize(field.label),
          label: field.label,
          type: field.type === "file" ? "file" : field.tag === "select" ? "select" : field.type,
          options
        });
      }
      continue;
    }
    try {
      await fillControl(locator, field, answer.value);
      fields.push(fieldSummary(field, answer));
    } catch (error) {
      unresolved.push({
        key: field.name || field.id || normalize(field.label), label: field.label,
        type: field.type, options: field.options, problem: error.message
      });
      fields.push(fieldSummary(field));
    }
  }
  return { unresolved, fields };
}

function credentialMatches(credential, currentUrl) {
  if (!credential?.origin) return false;
  try { return new URL(credential.origin).hostname === new URL(currentUrl).hostname; }
  catch { return false; }
}

function fieldSummary(field, answer) {
  let value;
  if (answer) {
    if (field.type === "password") value = "[stored securely]";
    else if (field.type === "file") value = path.basename(String(answer.value));
    else if (field.type === "checkbox") value = answer.value === true ? "Yes" : "No";
    else value = String(answer.value).slice(0, 240);
  }
  return {
    key: field.name || field.id || normalize(field.label), label: field.label,
    type: field.type, required: field.required, status: answer ? "filled" : "unfilled",
    ...(answer ? { value, source: answer.source } : {})
  };
}

async function radioOptions(locator, name) {
  const options = [];
  const radios = locator.page().locator('input[type="radio"]');
  for (let index = 0; index < await radios.count(); index += 1) {
    const candidate = radios.nth(index);
    if ((await candidate.getAttribute("name")) !== name) continue;
    const description = await describe(candidate);
    options.push({ value: await candidate.getAttribute("value"), label: description.label });
  }
  return options;
}

async function detectChallenge(page) {
  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 50_000);
  const challengeFrame = page.frames().some((frame) => /recaptcha|hcaptcha|turnstile/i.test(frame.url()));
  return challengeFrame || CHALLENGE_TEXT.test(body);
}

async function findAction(page) {
  const candidates = page.locator('button:visible, input[type="submit"]:visible');
  for (let index = (await candidates.count()) - 1; index >= 0; index -= 1) {
    const locator = candidates.nth(index);
    const text = (await locator.innerText().catch(() => "")) || (await locator.getAttribute("value")) || "";
    if (FINAL_BUTTON.test(text)) return { locator, final: true, text };
  }
  for (let index = (await candidates.count()) - 1; index >= 0; index -= 1) {
    const locator = candidates.nth(index);
    const text = (await locator.innerText().catch(() => "")) || (await locator.getAttribute("value")) || "";
    if (START_BUTTON.test(text)) return { locator, final: false, text };
  }
  for (let index = (await candidates.count()) - 1; index >= 0; index -= 1) {
    const locator = candidates.nth(index);
    const text = (await locator.innerText().catch(() => "")) || (await locator.getAttribute("value")) || "";
    if (NEXT_BUTTON.test(text)) return { locator, final: false, text };
  }
  for (let index = (await candidates.count()) - 1; index >= 0; index -= 1) {
    const locator = candidates.nth(index);
    const text = (await locator.innerText().catch(() => "")) || (await locator.getAttribute("value")) || "";
    if (AUTH_BUTTON.test(text)) return { locator, final: false, text };
  }
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

export async function automateApplication({ page, profile, opportunity, application, artifactsDirectory }) {
  await page.goto(opportunity.applyUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  // React-based ATS pages can finish DOMContentLoaded before the application
  // controls are mounted. Wait for a real control so the first inspection does
  // not incorrectly classify a supported form as empty.
  await page.locator("input, textarea, select, button").first()
    .waitFor({ state: "attached", timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(250);
  const observedFields = new Map();
  // Account creation plus a multi-page application can legitimately exceed
  // eight transitions while remaining bounded and reviewable.
  for (let step = 0; step < 16; step += 1) {
    if (await detectChallenge(page)) {
      return {
        status: "needs_human",
        message: "The application site presented a human verification challenge",
        requirements: [{ kind: "human_challenge", action: "manual_review", message: "Complete or inspect the browser challenge" }]
      };
    }
    const landingAction = await findAction(page);
    if (step === 0 && landingAction && !landingAction.final && START_BUTTON.test(landingAction.text)
      && !/\/(?:apply|application)(?:\/|$)/i.test(new URL(page.url()).pathname)) {
      const pagesBeforeClick = new Set(page.context().pages());
      await landingAction.locator.click({ noWaitAfter: true });
      await page.waitForTimeout(750);
      const popup = page.context().pages().find((candidate) => !pagesBeforeClick.has(candidate));
      if (popup) page = popup;
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      continue;
    }
    if (await openSignupForGeneratedCredential(page, profile.siteCredential)) continue;
    const { unresolved, fields } = await fillVisibleFields(page, profile, application.answers ?? {});
    for (const field of fields) observedFields.set(`${field.key}:${field.label}`, field);
    if (unresolved.length) {
      const verification = unresolved.find((field) => VERIFICATION_FIELD.test(`${field.key} ${field.label}`));
      if (verification) {
        return {
          status: "needs_input", message: "The site requires account verification",
          requirements: [{ kind: "authentication_verification", message: verification.label,
            fields: [verification.key], options: verification.options, recommendation: "custom" }]
        };
      }
      const password = unresolved.find((field) => field.type === "password");
      if (password) {
        const signupAvailable = await hasSignupAction(page);
        return {
          status: "needs_input", message: "The job site requires an account credential",
          requirements: [{
            kind: "account_credentials", message: `Credentials are required for ${new URL(page.url()).hostname}`,
            fields: ["siteAccountAction"], origin: new URL(page.url()).origin,
            options: signupAvailable ? [{ label: "Create a managed account", value: "generate", recommended: true }] : [],
            recommendation: signupAvailable ? "generate" : "custom"
          }]
        };
      }
      return {
        status: "needs_input",
        message: "Required application questions need answers",
        requirements: unresolved.map((field) => ({
          kind: field.type === "checkbox" ? "legal_attestation" : "missing_answer",
          message: field.problem ? `${field.label}: ${field.problem}` : field.label,
          fields: [field.key], options: field.options.map((option) => ({ ...option, recommended: false })),
          recommendation: "custom"
        }))
      };
    }
    const action = await findAction(page);
    if (!action) {
      return {
        status: "needs_human", message: "No supported application action was found",
        requirements: [{ kind: "unsupported_form", action: "manual_review", message: "Inspect this application form manually" }]
      };
    }
    const previousUrl = page.url();
    const bodyBeforeSubmit = action.final
      ? (await page.locator("body").innerText().catch(() => "")).slice(0, 50_000)
      : "";
    if (action.final) {
      const preview = previewOf(observedFields, page.url());
      const previewFingerprint = createHash("sha256").update(JSON.stringify(preview)).digest("hex");
      if (application.finalApprovalRequired
        && application.finalSubmissionApproval?.previewFingerprint !== previewFingerprint) {
        return {
          status: "needs_input", message: "Review all fields before the final submission",
          requirements: [{
            kind: "final_submission_approval", message: "Ready for your approval before Submit",
            fields: [], preview, previewFingerprint, recommendation: "approve"
          }]
        };
      }
    }
    const pagesBeforeClick = new Set(page.context().pages());
    // Sites frequently keep authentication and multi-step transitions entirely
    // client-side. Do not let Playwright's implicit navigation wait consume the
    // whole action timeout; the explicit load-state wait below handles real
    // navigations while DOM-only transitions can continue immediately.
    await action.locator.click({ noWaitAfter: true });
    await page.waitForTimeout(750);
    const popup = page.context().pages().find((candidate) => !pagesBeforeClick.has(candidate));
    if (popup) page = popup;
    if (!action.final) {
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      continue;
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    const verified = await waitForSubmissionEvidence(page, previousUrl, bodyBeforeSubmit);
    if (!verified) {
      return {
        status: "needs_human",
        message: "The submit action ran, but the site did not provide a verifiable confirmation",
        requirements: [{ kind: "submission_unverified", action: "manual_review", message: "Check whether the application was received before retrying" }]
      };
    }
    return { status: "submitted", receipt: await captureReceipt(page, artifactsDirectory, application.id) };
  }
  return {
    status: "needs_human", message: "The application exceeded the supported number of form steps",
    requirements: [{ kind: "unsupported_form", action: "manual_review", message: "Complete this multi-step application manually" }]
  };
}

function previewOf(observedFields, destination) {
  const fields = [...observedFields.values()];
  return {
    destination,
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
