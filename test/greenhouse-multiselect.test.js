import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { automateApplication } from "../worker/automation.js";

// The readonly Tavily DOM capture observed an ID-only select__input combobox,
// .select-shell and select__value-container--is-multi. Chip selectors derive
// from upstream react-select MultiValue; no live applicant selection was made.
function html(multiple = true) {
  return `<form onsubmit="event.preventDefault();document.body.innerHTML='<h2>Your application was successfully submitted.</h2>'">
<label id="language-label">Which languages do you speak?*</label>
<div class="select-shell"><div class="select__control"><div class="select__value-container ${multiple ? 'select__value-container--is-multi' : ''}">
<div class="select__input-container"><input id="${multiple ? 'question_9654007101[]' : 'languages'}" ${multiple ? '' : 'name="languages"'} class="select__input" role="combobox" aria-labelledby="language-label" aria-required="true" aria-expanded="false" autocomplete="off"></div>
</div></div><div id="options" role="listbox" ${multiple ? 'aria-multiselectable="true"' : ''} hidden></div></div>
<button type="submit">Submit Application</button></form>
<script>
const input=document.querySelector('[role=combobox]'),list=document.querySelector('[role=listbox]'),values=document.querySelector('.select__value-container');
function show(){list.hidden=false;input.setAttribute('aria-expanded','true');list.replaceChildren();for(const value of ['English','Hebrew','German']){if(!value.toLowerCase().includes(input.value.toLowerCase()))continue;const item=document.createElement('div');item.setAttribute('role','option');item.textContent=value;item.onclick=()=>{${multiple ? `const chip=document.createElement('div');chip.className='select__multi-value';const label=document.createElement('div');label.className='select__multi-value__label';label.textContent=value;chip.append(label);values.insertBefore(chip,input.parentElement);` : `let label=values.querySelector('.select__single-value');if(!label){label=document.createElement('div');label.className='select__single-value';values.prepend(label);}label.textContent=value;`}input.value='';list.hidden=true;input.setAttribute('aria-expanded','false');};list.append(item);}}
input.addEventListener('input',show);input.addEventListener('keydown',event=>{if(event.key==='ArrowDown')show();});
</script>`;
}

async function run(t, { multiple = true, mutation, answer = multiple ? ["English", "Hebrew"] : "English" } = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const directory = await mkdtemp(path.join(os.tmpdir(), "multiselect-fixture-"));
  t.after(async () => { await context.close(); await browser.close(); await rm(directory, { recursive: true, force: true }); });
  let preview;
  let commits = 0;
  let finals = 0;
  const result = await automateApplication({ page,
    profile: { id: "fixture", contact: {}, documents: {}, links: {}, applicationAnswers: {} },
    opportunity: { title: "Engineer", company: "Fixture", applyUrl: `data:text/html,${encodeURIComponent(html(multiple))}` },
    application: { id: "fixture", standingPolicyVersion: 1, claim: { attemptId: "synthetic-attempt" }, answers: { [multiple ? "question_9654007101[]" : "languages"]: answer } },
    artifactsDirectory: directory,
    authorizeFinal: async input => {
      preview = input.preview;
      if (mutation) await page.evaluate(kind => {
        const labels=[...document.querySelectorAll('.select__multi-value__label')];
        if(kind==='missing') labels.at(-1)?.closest('.select__multi-value').remove();
        if(kind==='changed') labels.at(-1).textContent='German';
        if(kind==='extra'){const extra=labels[0].closest('.select__multi-value').cloneNode(true);extra.querySelector('.select__multi-value__label').textContent='German';document.querySelector('.select__value-container').prepend(extra);}
      }, mutation);
      return { decision: "permit", permit: "synthetic-permit" };
    },
    commitFinal: async () => { commits += 1; return { committed: true }; },
    markFinalActionStarted: async () => { finals += 1; }
  });
  return { result, preview, commits, finals };
}

test("multi combobox selects English and Hebrew independently and preserves exact array preview", async t => {
  const r = await run(t);
  assert.equal(r.result.status, "submitted");
  assert.deepEqual(r.preview.filled.find(field => field.key === "question_9654007101[]").value, ["English", "Hebrew"]);
  assert.equal(r.commits, 1);
  assert.equal(r.finals, 1);
});
for (const mutation of ["missing", "changed", "extra"]) {
  test(`${mutation} multiselect chip invalidates final review`, async t => {
    const r = await run(t, { mutation });
    assert.equal(r.result.status, "needs_input");
    assert.equal(r.result.requirements[0].kind, "final_review_changed");
    assert.equal(r.commits, 0);
    assert.equal(r.finals, 0);
  });
}
test("an unknown multiselect value never becomes a guessed comma-joined option", async t => {
  const r = await run(t, { answer: ["English", "Unknown language"] });
  assert.equal(r.result.status, "needs_input");
  assert.equal(r.commits, 0);
  assert.equal(r.finals, 0);
});
test("existing single combobox remains valid", async t => {
  const r = await run(t, { multiple: false });
  assert.equal(r.result.status, "submitted");
  assert.equal(r.preview.filled.find(field => field.key === "languages").value, "English");
  assert.equal(r.commits, 1);
  assert.equal(r.finals, 1);
});
