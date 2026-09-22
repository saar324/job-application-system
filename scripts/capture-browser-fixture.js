#!/usr/bin/env node
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createUrlPolicy } from "../worker/url-policy.js";

const { values } = parseArgs({ options: {
  url: { type: "string" }, output: { type: "string" }, synthetic: { type: "boolean", default: false }
} });
if (!values.url || !values.output || values.synthetic !== true) {
  throw new Error("--url, --output, and --synthetic are required; capture only synthetic fixtures");
}
const url = new URL(values.url);
const policy = createUrlPolicy({ WORKER_ALLOWED_DOMAINS: url.hostname });
policy.assertAllowed(url.toString());
await policy.assertPublic(url.toString());
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ acceptDownloads: false });
  await context.route("**/*", async (route) => {
    try { if (/^https?:/i.test(route.request().url())) await policy.assertPublic(route.request().url());
      await route.continue(); } catch { await route.abort("blockedbyclient"); }
  });
  const page = await context.newPage();
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
  const fixture = {
    capturedAt: new Date().toISOString(), synthetic: true, url: page.url(), title: await page.title(),
    accessibility: await page.locator("body").ariaSnapshot(),
    controls: await page.locator("input, textarea, select, button, a").evaluateAll((elements) => elements.slice(0, 300).map((element) => ({
      tag: element.tagName.toLowerCase(), type: element.getAttribute("type"), name: element.getAttribute("name"),
      id: element.id || undefined, label: element.getAttribute("aria-label") || element.innerText || element.getAttribute("placeholder"),
      required: element.required === true
    })))
  };
  const output = path.resolve(values.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
  console.log(output);
  await context.close();
} finally { await browser.close(); }
