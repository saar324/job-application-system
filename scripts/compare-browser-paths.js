#!/usr/bin/env node
// Local fixture only. This script never navigates to an employer or sends an application.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const iterations = 5;
const fixture = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><form
  onsubmit="event.preventDefault();document.body.innerHTML='<h1>Fixture received</h1>'">
  <label>LinkedIn URL<input name="linkedin"></label>
  <button type="submit">Submit fixture</button></form>`)}`;
const output = [];

for (const mode of ["headless", "headed", "headed_separate_profile"]) {
  const profileDir = mode === "headed_separate_profile"
    ? await mkdtemp(path.join(os.tmpdir(), "job-browser-fixture-")) : null;
  let browser; let persistent;
  try {
    if (profileDir) persistent = await chromium.launchPersistentContext(profileDir,
      { headless: false, args: ["--disable-quic"] });
    else browser = await chromium.launch({ headless: mode === "headless", args: ["--disable-quic"] });
    const samples = [];
    let received = 0;
    for (let index = 0; index < iterations; index += 1) {
      const context = persistent ?? await browser.newContext();
      const page = await context.newPage();
      const start = performance.now();
      await page.goto(fixture);
      await page.locator("input[name=linkedin]").fill("https://www.linkedin.com/in/fixture/");
      await page.locator("input[name=linkedin]").blur();
      await page.waitForTimeout(650);
      if (await page.locator("input[name=linkedin]").inputValue() === "https://www.linkedin.com/in/fixture/") {
        await page.getByRole("button", { name: "Submit fixture" }).click();
      }
      if (await page.getByRole("heading", { name: "Fixture received" }).count()) received += 1;
      samples.push(Math.round(performance.now() - start));
      await page.close();
      if (!persistent) await context.close();
    }
    samples.sort((left, right) => left - right);
    output.push({ mode, fixtureReceipts: received, iterations,
      p50Ms: samples[Math.ceil(iterations * 0.5) - 1],
      p95Ms: samples[Math.ceil(iterations * 0.95) - 1],
      challengeRate: null, modelCalls: 0 });
  } catch (error) {
    output.push({ mode, error: String(error.message ?? error).slice(0, 300) });
  } finally {
    await persistent?.close();
    await browser?.close();
    if (profileDir) await rm(profileDir, { recursive: true, force: true });
  }
}
process.stdout.write(`${JSON.stringify({ kind: "controlled_fixture_only", results: output })}\n`);
