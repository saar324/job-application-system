import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProfileStore } from "../src/profile-store.js";
import { reusableApprovedAnswer } from "../src/approved-answers.js";
import { JsonStore } from "../src/store.js";
import { ApplicationService } from "../src/service.js";
import { SimulationAdapter } from "../src/adapters/simulation.js";
import { createHttpServer } from "../src/http.js";

test("only the profile owner can approve a current employer-scoped answer", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "approved-answers-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("person", { contact: { firstName: "Ada", email: "ada@example.test" } });
  const input = [{ id: "why-example", question: "Why this company?", value: "Its work matches my experience.",
    scope: { employer: "Example" } }];
  await assert.rejects(profiles.patch("person", { approvedAnswers: input }), /not allowed/);
  await assert.rejects(profiles.setApprovedAnswers("person", input,
    { actorId: "agent", profileId: "person", roles: ["agent"] }), /owner authority/);
  const result = await profiles.setApprovedAnswers("person", input,
    { actorId: "owner", profileId: "person", roles: ["owner"] });
  assert.equal(result.count, 1);
  const profile = await profiles.get("person");
  const answer = profile.approvedAnswers[0];
  const opportunity = { company: "Example", title: "Senior Engineer" };
  assert.equal(reusableApprovedAnswer(answer, profile, opportunity, input[0].question), true);
  assert.equal(reusableApprovedAnswer(answer, profile, { ...opportunity, company: "Other" }, input[0].question), false);
  assert.equal(reusableApprovedAnswer(answer, { ...profile,
    contact: { ...profile.contact, email: "changed@example.test" } }, opportunity, input[0].question), false);
  assert.equal(reusableApprovedAnswer({ ...answer, value: "Changed" }, profile, opportunity, input[0].question), false);
  assert.equal(reusableApprovedAnswer(answer, profile, opportunity, input[0].question,
    Date.parse(answer.reviewAfter) + 1), false);
});

test("HTTP approval route rejects the agent credential and ordinary profile PATCH", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "approved-answers-http-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const config = { defaultMode: "full_time", modes: { full_time: { minimumScore: 0 } } };
  const service = new ApplicationService({ store, profiles, config, adapter: new SimulationAdapter() });
  const server = createHttpServer({ service, profiles, config, discovery: {},
    authenticate: (request) => request.headers.authorization === "Bearer owner-token"
      ? { actorId: "owner", profileId: "person", roles: ["owner"] }
      : request.headers.authorization === "Bearer agent-token"
        ? { actorId: "agent", profileId: "person", roles: ["agent"] } : null });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const answers = [{ id: "why", question: "Why this company?", value: "Its work fits my skills.",
    scope: { employer: "Example" } }];
  try {
    const send = (route, method, token, body) => fetch(`${base}${route}`, { method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body) });
    assert.equal((await send("/v1/profile/approved-answers", "PUT", "agent-token",
      { answers })).status, 403);
    assert.equal((await send("/v1/profile", "PATCH", "agent-token",
      { approvedAnswers: answers })).status, 400);
    assert.equal((await send("/v1/profile/approved-answers", "PUT", "owner-token",
      { answers })).status, 200);
    assert.equal((await profiles.get("person")).approvedAnswers.length, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
