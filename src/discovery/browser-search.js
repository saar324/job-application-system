import { settleSourcePage } from "./browser-settle.js";

// Listing URLs and their selected geography are reviewed per source. A generic
// location input has different meanings across boards, so search only by role
// and leave any existing region/country selection untouched.
export async function applyBroadSearch(page, query, budget, settle = settleSourcePage) {
  const selectors = [
    'input[type="search"]', 'input[name*="keyword" i]', 'input[name*="search" i]',
    'input[placeholder*="job" i]', 'input[placeholder*="role" i]',
    'input[placeholder*="keyword" i]'
  ];
  for (const selector of selectors) {
    const inputs = page.locator(selector);
    for (let index = 0; index < Math.min(await inputs.count(), 4); index += 1) {
      const input = inputs.nth(index);
      if (!await input.isVisible().catch(() => false)) continue;
      const label = await Promise.all(["name", "id", "placeholder", "aria-label"]
        .map((name) => input.getAttribute(name).catch(() => null)));
      if (/locat|city|country|region|where/i.test(label.filter(Boolean).join(" "))) continue;
      const before = page.url();
      await input.fill(query);
      const submit = page.locator("button[data-submit]").filter({ visible: true }).first();
      if (await submit.isVisible().catch(() => false)) {
        await submit.click({ timeout: 3_000, noWaitAfter: true }).catch(() => undefined);
      } else await input.press("Enter");
      await settle(page, budget);
      if (page.url() === before) {
        const button = page.getByRole("button", { name: /^search$/i }).filter({ visible: true }).first();
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 3_000, noWaitAfter: true }).catch(() => undefined);
          await settle(page, budget);
        }
      }
      return true;
    }
  }
  return false;
}
