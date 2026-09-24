import assert from "node:assert/strict";
import test from "node:test";
import { greenhouseRemoteRole } from "../src/discovery/greenhouse-remote.js";
import { fetchVerifiedOfficialAtsRole, revalidateOfficialAtsRole } from "../src/discovery/official-ats.js";
import { greenhouse } from "../src/discovery/sources/greenhouse.js";

const applyUrl = "https://job-boards.greenhouse.io/example/jobs/12345";
const row = { id: 12345, title: "Senior Platform Developer", absolute_url: applyUrl,
  location: { name: "Europe" }, content: "<p>This is a fully remote position for engineers in Europe.</p>" };

test("current employer wording promotes an exact Greenhouse role through feed and detail", async () => {
  const fetchImpl = async (url) => new Response(JSON.stringify(
    String(url).includes("/jobs?") ? { jobs: [row] } : row));
  const feed = await greenhouse.search({ sourceConfig: { boards: [{ token: "example",
    company: "Example" }] }, profile: { preferences: { fullTime: {
    jobTitles: ["Platform Developer"] } } }, fetchImpl });
  assert.equal(feed.length, 1);
  assert.equal(feed[0].remote, true);
  assert.equal(feed[0].location, "Europe");
  const verified = await fetchVerifiedOfficialAtsRole(applyUrl, {}, fetchImpl);
  assert.equal(verified.applicationDestinationVerified, true);
  assert.equal(verified.remote, true);
  assert.equal(verified.location, "Europe");
  assert.equal(await revalidateOfficialAtsRole(verified, fetchImpl), true);
});

test("a remote-work perk, aggregator label, hybrid wording, and changed region do not authorize", async () => {
  const perk = { ...row, content: "<p>Benefits include remote work and an office.</p>" };
  assert.equal(greenhouseRemoteRole(perk), false);
  assert.equal(greenhouseRemoteRole({ ...row, content: "<p>Hybrid role with remote days.</p>" }), false);
  assert.equal(greenhouseRemoteRole({ ...row, content: "<p>Not a fully remote role.</p>" }), false);
  assert.equal(greenhouseRemoteRole({ ...row, content: "<p>Remote role not available.</p>" }), false);
  assert.equal(greenhouseRemoteRole({ ...row, content: "<p>No remote positions.</p>" }), false);
  assert.equal(greenhouseRemoteRole({ ...row, title: "Remote Sensing Engineer",
    content: "<p>Build sensors in the office.</p>" }), false);
  assert.equal(greenhouseRemoteRole({ ...row, content: "<p>#LI-REMOTE</p>" }), true);
  assert.equal(await fetchVerifiedOfficialAtsRole(applyUrl, {}, async () =>
    new Response(JSON.stringify(perk))), null);
  const verified = await fetchVerifiedOfficialAtsRole(applyUrl, {}, async () =>
    new Response(JSON.stringify(row)));
  assert.equal(await revalidateOfficialAtsRole(verified, async () =>
    new Response(JSON.stringify({ ...row, content: "<p>Hybrid role.</p>" }))), false);
  assert.equal(await revalidateOfficialAtsRole(verified, async () =>
    new Response(JSON.stringify({ ...row, location: { name: "Germany" } }))), false);
});

test("fully remote work remains eligible when the company also hosts onsite team events", () => {
  assert.equal(greenhouseRemoteRole({ ...row, location: { name: "Europe (Full Remote)" },
    content: "<p>Fully remote work from Europe.</p><p>Onsite team events in Warsaw.</p>" }), true);
  assert.equal(greenhouseRemoteRole({ ...row,
    content: "<p>Fully remote work from Europe.</p><p>Onsite work three days each week.</p>" }), false);
});
