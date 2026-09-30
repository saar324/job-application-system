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

test("public starter has reusable sources without applicant policy or employer boards", async () => {
  const catalog = JSON.parse(await readFile("skills/job-application/references/public-sources.json", "utf8"));
  const sources = [...catalog.autonomousDiscovery.serverAdapters,
    ...catalog.autonomousDiscovery.visibleBrowserSources];
  assert.equal(sources.length, 14);
  assert.equal(new Set(sources.map((source) => source.id)).size, sources.length);
  assert.ok(sources.every((source) => Object.keys(source).sort().join(",") === "id,name,url"));
  assert.ok(sources.every((source) => {
    const url = new URL(source.url);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }));
  assert.deepEqual(catalog.autonomousDiscovery.priorityOrder, []);
  assert.deepEqual(catalog.userControlled, []);
  assert.ok(Object.values(catalog.searchPolicy).every((value) => value === ""
    || Array.isArray(value) && value.length === 0));
});
