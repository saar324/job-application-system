import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("shared source catalog is a neutral, empty private-config template", async () => {
  const catalog = JSON.parse(await readFile("skills/job-application/references/sources.json", "utf8"));
  const sources = [
    ...catalog.autonomousDiscovery.serverAdapters,
    ...catalog.autonomousDiscovery.visibleBrowserSources
  ];
  assert.equal(catalog.version, 1);
  assert.deepEqual(sources, []);
  assert.deepEqual(catalog.autonomousDiscovery.priorityOrder, []);
  assert.deepEqual(catalog.userControlled, []);
  assert.deepEqual(catalog.searchPolicy.screeningRules, []);
});
