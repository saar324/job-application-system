import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DiscoveryService } from "../src/discovery/service.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";

const identity = { actorId: "agent", profileId: "person", roles: ["agent"] };
const owner = { actorId: "owner", profileId: "person", roles: ["owner"] };
const id = (digit) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const job = (digit, title) => ({ id: id(digit), title, isRemote: true,
  location: "Worldwide", descriptionPlain: "TypeScript Node.js platform",
  employmentType: "Full-Time", isListed: true,
  applyUrl: `https://jobs.ashbyhq.com/example/${id(digit)}/application`,
  jobUrl: `https://jobs.ashbyhq.com/example/${id(digit)}` });

test("caller cannot forge or erase server-owned advisory provenance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "staged-provenance-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const config = { defaultMode: "full_time", modes: { full_time: { minimumScore: 0 } } };
  const service = new ApplicationService({ store, config, adapter: { name: "chrome_session" } });
  const role = { title: "Engineer", company: "Example", applyUrl: "https://example.test/role",
    discoveryRelease: { stage: "advisory", sourceId: "ashby", reason: "broadened_title" } };
  const forged = await service.addOpportunity(role, identity);
  assert.equal(forged.discoveryRelease, undefined);
  const verified = await service.addOpportunity({ ...role,
    applyUrl: "https://example.test/second" }, identity,
  { serverVerifiedDiscovery: true, advisoryDiscovery: role.discoveryRelease });
  assert.equal(verified.discoveryRelease.stage, "advisory");
  const repeated = await service.addOpportunity({ ...role, applyUrl: verified.applyUrl,
    discoveryRelease: null }, identity);
  assert.equal(repeated.discoveryRelease.stage, "advisory");
});
