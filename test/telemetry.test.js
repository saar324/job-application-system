import assert from "node:assert/strict";
import test from "node:test";
import { safeAttributes, Telemetry } from "../src/telemetry.js";

test("telemetry drops secret and applicant-content attributes", () => {
  assert.deepEqual(safeAttributes({ route: "/apply", password: "secret", applicantAnswer: "yes",
    resumePath: "/private/resume.pdf", status: 200 }), { route: "/apply", status: 200 });
});

test("local telemetry health remains available without an exporter", () => {
  const telemetry = new Telemetry("test");
  telemetry.count("jobs", 2, { mode: "full_time" });
  telemetry.observe("duration", 10);
  assert.equal(telemetry.health().counters.jobs, 2);
  assert.equal(telemetry.health().histograms.duration.average, 10);
});
