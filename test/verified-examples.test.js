import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/http.js";
import { ProfileStore } from "../src/profile-store.js";
import { buildEvidencePacket } from "../src/service.js";

const ownerOne = { actorId: "owner-one", profileId: "profile-one", roles: ["owner"] };
const ownerTwo = { actorId: "owner-two", profileId: "profile-two", roles: ["owner"] };
const agentOne = { actorId: "agent-one", profileId: "profile-one", roles: ["agent"] };

function example(id = "backend-api", overrides = {}) {
  return { id, facts: ["Built a fictional production API using TypeScript and PostgreSQL."],
    source: { kind: "owner_statement", reference: "Owner review of work history" },
    scope: { roleTerms: ["backend"], skillTerms: ["PostgreSQL"] },
    reviewAfter: new Date(Date.now() + 30 * 86_400_000).toISOString(), ...overrides };
}

async function profileFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-verified-examples-"));
  return new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
}

test("only the owner can verify examples for their own profile", async () => {
  const profiles = await profileFixture();
  await assert.rejects(profiles.setVerifiedExamples("profile-one", [example()], agentOne),
    (error) => error.status === 403);
  await assert.rejects(profiles.setVerifiedExamples("profile-two", [example()], ownerOne),
    (error) => error.status === 403);
  await assert.rejects(profiles.patch("profile-one", { verifiedExamples: [example()] }),
    (error) => error.status === 400);
  const result = await profiles.setVerifiedExamples("profile-one", [example()], ownerOne);
  assert.equal(result.count, 1);
  assert.equal((await profiles.get("profile-one")).verifiedExamples[0].ownerActorId, "owner-one");
  assert.equal(await profiles.get("profile-two"), null);
});

test("example facts, provenance, scope, and review date are validated", async () => {
  const profiles = await profileFixture();
  for (const invalid of [
    example("same", { facts: [] }),
    example("same", { scope: {} }),
    example("same", { source: { kind: "unknown", reference: "Owner" } }),
    example("same", { reviewAfter: new Date(Date.now() - 1_000).toISOString() }),
    example("bad:id")
  ]) {
    await assert.rejects(profiles.setVerifiedExamples("profile-one", [invalid], ownerOne),
      (error) => error.status === 400);
  }
  await assert.rejects(profiles.setVerifiedExamples("profile-one",
    [example("duplicate"), example("duplicate")], ownerOne),
  (error) => error.status === 400);
  assert.equal(await profiles.get("profile-one"), null);
});

test("draft evidence includes only current examples relevant to the role and employer", async () => {
  const profiles = await profileFixture();
  await profiles.setVerifiedExamples("profile-one", [example(),
    example("frontend-ui", { facts: ["Built a fictional design system."],
      scope: { roleTerms: ["frontend"] } }),
    example("other-employer", { scope: { roleTerms: ["backend"], employer: "Other Co" } })
  ], ownerOne);
  const profile = await profiles.get("profile-one");
  const opportunity = { company: "Example Co", title: "Senior Back-end Engineer",
    description: "Build services with PostgreSQL and TypeScript.",
    listingUrl: "https://example.test/jobs/backend" };
  const packet = buildEvidencePacket({}, opportunity, profile);
  assert.deepEqual(packet.applicant.examples.map((item) => item.id), ["backend-api"]);
  assert.deepEqual(packet.applicant.examples[0].facts,
    ["Built a fictional production API using TypeScript and PostgreSQL."]);
  assert.equal(packet.applicant.examples[0].ownerActorId, undefined);
  const stale = { ...profile, verifiedExamples: profile.verifiedExamples.map((item) => ({
    ...item, reviewAfter: new Date(Date.now() - 1_000).toISOString()
  })) };
  assert.deepEqual(buildEvidencePacket({}, opportunity, stale).applicant.examples, []);
  const unverified = { ...profile, verifiedExamples: profile.verifiedExamples.map((item) => ({
    ...item, ownerActorId: undefined
  })) };
  assert.deepEqual(buildEvidencePacket({}, opportunity, unverified).applicant.examples, []);
});

test("verified-example HTTP routes require owner authority and keep profiles isolated", async () => {
  const profiles = await profileFixture();
  const authenticate = (request) => ({ "Bearer owner-one": ownerOne,
    "Bearer owner-two": ownerTwo, "Bearer agent-one": agentOne })[request.headers.authorization] ?? null;
  const service = { adapter: { name: "test" } };
  const server = createHttpServer({ service, discovery: {}, profiles, authenticate,
    config: { defaultMode: "full_time" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (token, body) => fetch(`${base}/v1/profile/verified-examples`, { method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body) });
  const get = (token) => fetch(`${base}/v1/profile/verified-examples`,
    { headers: { authorization: `Bearer ${token}` } });
  try {
    assert.equal((await put("agent-one", { examples: [example()] })).status, 403);
    assert.equal((await put("owner-one", { examples: [example()], profileId: "profile-two" })).status, 400);
    assert.equal((await put("owner-one", { examples: [example()] })).status, 200);
    assert.equal((await get("agent-one")).status, 403);
    assert.equal((await get("owner-one")).status, 200);
    assert.equal((await (await get("owner-one")).json()).examples.length, 1);
    assert.deepEqual((await (await get("owner-two")).json()).examples, []);
    assert.equal((await get("missing")).status, 401);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
