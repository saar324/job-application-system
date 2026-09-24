import assert from "node:assert/strict";
import test from "node:test";
import { applyBroadSearch } from "../src/discovery/browser-search.js";

test("role search leaves a source's selected geography untouched", async () => {
  const location = input({ type: "search", id: "jobLocation", placeholder: "Job Location",
    value: "Europe" });
  const role = input({ placeholder: "Role", value: "" });
  let currentUrl = "https://board.example.test/europe/jobs";
  role.press = async () => { currentUrl += "?query=platform"; };
  const page = {
    url: () => currentUrl,
    locator(selector) {
      const found = selector === 'input[type="search"]' ? [location]
        : selector === 'input[placeholder*="job" i]' ? [location]
          : selector === 'input[placeholder*="role" i]' ? [role] : [];
      return { count: async () => found.length, nth: (index) => found[index],
        filter: () => ({ first: () => ({ isVisible: async () => false }) }) };
    },
    getByRole: () => ({ filter: () => ({ first: () => ({ isVisible: async () => false }) }) })
  };
  assert.equal(await applyBroadSearch(page, "platform", {}, async () => {}), true);
  assert.equal(location.value, "Europe");
  assert.equal(role.value, "platform");
  assert.equal(currentUrl, "https://board.example.test/europe/jobs?query=platform");
});

function input({ type, id, placeholder, value }) {
  return { value, isVisible: async () => true,
    getAttribute: async (name) => ({ type, id, placeholder })[name] ?? null,
    fill: async function fill(next) { this.value = next; },
    press: async () => {} };
}
