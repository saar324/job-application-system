// Ashby renders required questions with custom controls lacking native
// required attributes. Use exact answers and verify each selected value.
const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const countryKey = (value) => normalize(value).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export async function ashbyValidationErrors(surface, fields = []) {
  if (new URL(surface.url()).hostname !== "jobs.ashbyhq.com") return [];
  const labels = await surface.locator('[role="alert"]').evaluateAll((alerts) => alerts
    .filter((alert) => /your form needs corrections/i.test(alert.textContent ?? ""))
    .flatMap((alert) => [...alert.querySelectorAll("button")].map((button) => button.textContent?.trim())
      .filter(Boolean)));
  return [...new Set(labels)].map((rawLabel) => {
    const label = rawLabel.replace(/^missing entry for required field:\s*/i, "").trim();
    const field = fields.find((item) => normalize(item.label) === normalize(label));
    return { label, key: field?.key ?? label, field };
  });
}

export async function repairAshbyRadioErrors(surface, errors) {
  if (!errors.length || errors.some((error) => error.field?.controlType !== "radio"
    || error.field.status !== "filled")) return false;
  for (const { field } of errors) {
    const groups = surface.locator(".ashby-application-form-input-radio-group");
    let group;
    for (const candidate of await groups.all()) {
      const label = await candidate.locator(".ashby-application-form-question-title").textContent();
      if (normalize(label) === normalize(field.label)) { group = candidate; break; }
    }
    if (!group) return false;
    const inputs = group.locator('input[type="radio"]');
    let selected;
    for (let index = 0; index < await inputs.count(); index += 1) {
      const candidate = inputs.nth(index);
      const label = await group.locator(`label[for="${await candidate.getAttribute("id")}"]`).textContent();
      if (normalize(label) === normalize(field.value)) { selected = index; break; }
    }
    if (selected === undefined) return false;
    // Ashby can render a checked input while its saved form value is empty.
    // Move away and back so React receives a real change for the same answer.
    if (await inputs.nth(selected).isChecked()) {
      const alternative = selected === 0 ? 1 : 0;
      if (alternative >= await inputs.count()) return false;
      await inputs.nth(alternative).click();
    }
    await inputs.nth(selected).click();
    if (!await inputs.nth(selected).isChecked()) return false;
  }
  return true;
}

export async function fillAshbyRequiredControls(surface, profile, answers = {}) {
  const entries = await surface.locator("body").evaluate((body) => {
    const required = (label) => [...(label?.classList ?? [])].some((name) => name.includes("_required_"));
    const question = (container) => container.querySelector("label.ashby-application-form-question-title");
    const fields = [];
    [...body.querySelectorAll(".ashby-application-form-field-entry")].forEach((entry, index) => {
      const label = question(entry);
      const type = entry.querySelector('input[role="combobox"]') ? "combobox"
        : entry.querySelector(".ashby-application-form-input-yesno") ? "yesno" : null;
      const isRequired = required(label);
      const isLocation = type === "combobox" && /(?:^|\b)(?:location|located)(?:\b|$)/i.test(label?.textContent ?? "");
      if (!isRequired && !isLocation) return;
      if (type) fields.push({ type, index, required: isRequired,
        key: entry.getAttribute("data-field-path") || label.textContent.trim(),
        label: label.textContent.replace(/\s+/g, " ").trim(),
        description: entry.querySelector(".ashby-application-form-question-description")?.textContent?.trim() ?? "" });
    });
    [...body.querySelectorAll(".ashby-application-form-input-radio-group")].forEach((group, index) => {
      const label = question(group);
      if (!required(label)) return;
      fields.push({ type: "radio", index, key: label.getAttribute("for") || label.textContent.trim(),
        label: label.textContent.replace(/\s+/g, " ").trim(),
        options: [...group.querySelectorAll('input[type="radio"]')].map((input) => ({
          id: input.id, label: group.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent?.trim() ?? ""
        })) });
    });
    return fields;
  });
  const requirements = [];
  const fields = [];
  for (const field of entries) {
    let value = Object.hasOwn(answers, field.key) ? answers[field.key]
      : Object.hasOwn(answers, field.label) ? answers[field.label] : undefined;
    let source = "application answer";
    const locationQuestion = /(?:^|\b)(?:location|located)(?:\b|$)/i.test(field.label.trim());
    if (value === undefined && field.type === "combobox" && locationQuestion
      && (profile?.contact?.location || profile?.contact?.country || profile?.contact?.city)) {
      value = [profile.contact.location, profile.contact.country, profile.contact.city].filter(Boolean);
      source = "profile";
    }
    if (value === undefined && field.type === "yesno" && /work authorization|authori[sz]ed to work/i.test(field.label)) {
      const country = String(profile?.contact?.country ?? "").trim();
      const namedJurisdiction = field.label.match(/\bwork\s+in\s+([^?.,;]+)/i)?.[1]?.trim();
      const jurisdictionMatches = !namedJurisdiction || normalize(namedJurisdiction) === "that country"
        || normalize(namedJurisdiction).includes(normalize(country));
      const saved = country && jurisdictionMatches ? profile?.applicationAnswers?.[
        `Are you authorized to work in ${country} and for EU companies without visa sponsorship?`
      ] : undefined;
      if (saved !== undefined) { value = saved; source = "verified profile fact"; }
    }
    if (value === undefined && field.type === "yesno" && /independent contractor/i.test(field.label)) {
      const country = countryKey(profile?.contact?.country);
      const saved = country ? profile?.applicationAnswers?.[
        `can_work_full_time_independent_contractor_${country}`] : undefined;
      if (saved !== undefined) { value = saved; source = "verified profile fact"; }
    }
    const summary = { key: field.key, label: field.label, type: "ashby_custom",
      controlType: field.type, required: field.required !== false };
    try {
      if (value === undefined || value === "") throw new Error("answer required");
      if (field.type === "combobox") {
        const input = surface.locator(".ashby-application-form-field-entry").nth(field.index)
          .locator('input[role="combobox"]');
        const candidates = [...new Set((Array.isArray(value) ? value : [value])
          .flatMap((candidate) => [candidate, String(candidate).split(",")[0]])
          .concat(locationQuestion ? [profile?.contact?.city, profile?.contact?.country] : [])
          .filter(Boolean).map(String))];
        const preferred = [...new Set((Array.isArray(value) ? value : [value])
          .concat(locationQuestion ? [profile?.contact?.location] : [])
          .filter(Boolean).map((candidate) => normalize(candidate)))];
        const city = normalize(profile?.contact?.city || String(candidates[0] ?? "").split(",")[0]);
        const country = normalize(profile?.contact?.country
          || String((Array.isArray(value) ? value[0] : value) ?? "").split(",").at(-1));
        let selectedValue;
        for (const candidate of candidates) {
          await input.fill(String(candidate));
          const optionLocator = surface.getByRole("option");
          await optionLocator.first().waitFor({ state: "visible", timeout: 1500 }).catch(() => {});
          const visible = [];
          for (const option of await optionLocator.all()) {
            if (!await option.isVisible().catch(() => false)) continue;
            visible.push({ option, label: (await option.innerText()).trim() });
          }
          const exact = visible.find((item) => preferred.includes(normalize(item.label)));
          const cityCountry = locationQuestion && city && country
            ? visible.find((item) => normalize(item.label).startsWith(city)
              && normalize(item.label).includes(country)) : undefined;
          const choice = exact ?? cityCountry
            ?? visible.find((item) => normalize(item.label) === normalize(candidate));
          if (!choice) continue;
          await choice.option.click();
          selectedValue = choice.label;
          break;
        }
        if (!selectedValue) throw new Error("matching location option was not found");
        value = selectedValue;
        const selected = await input.evaluate((element) => ({
          value: element.value, expanded: element.getAttribute("aria-expanded")
        }));
        if (normalize(selected.value) !== normalize(value) || selected.expanded !== "false") {
          throw new Error("selection was not verified");
        }
      } else if (field.type === "yesno") {
        const choice = value === true ? "yes" : value === false ? "no" : normalize(value);
        if (!["yes", "no"].includes(choice)) throw new Error("answer must be Yes or No");
        const button = surface.locator(".ashby-application-form-field-entry").nth(field.index)
          .locator(`.ashby-application-form-input-yesno button[data-option="${choice}"]`);
        await button.click();
        if (await button.getAttribute("aria-pressed") !== "true") throw new Error("answer was not selected");
        value = choice === "yes" ? "Yes" : "No";
      } else {
        const option = field.options.find((item) => normalize(item.label) === normalize(value));
        if (!option) throw new Error("answer does not match a radio option");
        const group = surface.locator(".ashby-application-form-input-radio-group").nth(field.index);
        const input = group.locator('input[type="radio"]').nth(field.options.indexOf(option));
        await input.check();
        if (!await input.isChecked()) throw new Error("answer was not selected");
        value = option.label;
      }
      fields.push({ ...summary, status: "filled", value: String(value), source });
    } catch (error) {
      fields.push({ ...summary, status: "unfilled" });
      requirements.push({ kind: field.type === "combobox" ? "unsupported_control" : "missing_answer",
        ...(field.type === "combobox" ? { action: "manual_review" } : { recommendation: "custom" }),
        fields: [field.key], message: field.label + (error.message === "answer required" ? "" : `: ${error.message}`),
        ...(field.type === "yesno" ? { options: [
          { label: "Yes", value: "yes", recommended: false },
          { label: "No", value: "no", recommended: false }
        ] } : field.type === "radio" ? { options: field.options.map((item) => ({
          label: item.label, value: item.label, recommended: false
        })) } : {}) });
    }
  }
  return { fields, requirements };
}

export async function verifyAshbyRequiredControls(surface, fields) {
  return surface.locator("body").evaluate((body, expected) => expected.every((field) => {
    if (field.status !== "filled") return false;
    const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    if (field.controlType === "radio") {
      const group = [...body.querySelectorAll(".ashby-application-form-input-radio-group")]
        .find((item) => item.querySelector(".ashby-application-form-question-title")?.getAttribute("for") === field.key);
      const selected = group?.querySelector('input[type="radio"]:checked');
      return Boolean(selected && normalize(group.querySelector(`label[for="${CSS.escape(selected.id)}"]`)?.textContent)
        === normalize(field.value));
    }
    const entry = [...body.querySelectorAll(".ashby-application-form-field-entry")]
      .find((item) => item.getAttribute("data-field-path") === field.key);
    if (!entry) return false;
    if (field.controlType === "combobox") {
      const input = entry.querySelector('input[role="combobox"]');
      return Boolean(input && normalize(input.value) === normalize(field.value)
        && input.getAttribute("aria-expanded") === "false");
    }
    const choice = normalize(field.value);
    return entry.querySelector(`.ashby-application-form-input-yesno button[data-option="${choice}"]`)
      ?.getAttribute("aria-pressed") === "true";
  }), fields);
}
