import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CredentialVault, generateManagedPassword } from "../src/credential-vault.js";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-vault-test-"));
  const keys = {
    "applicant-one": randomBytes(32).toString("base64"),
    "applicant-two": randomBytes(32).toString("base64")
  };
  return { directory, vault: new CredentialVault({ directory, keys }) };
}

test("credential vault encrypts separate profile records by HTTPS origin", async () => {
  const { directory, vault } = await fixture();
  await vault.set("applicant-one", "https://jobs.example.com/login", { username: "applicant-one@example.test", password: "applicant-one-secret" });
  await vault.set("applicant-two", "https://jobs.example.com", { username: "applicant-two@example.test", password: "applicant-two-secret" });
  assert.equal((await vault.get("applicant-one", "https://jobs.example.com/apply")).password, "applicant-one-secret");
  assert.equal((await vault.get("applicant-two", "https://jobs.example.com/apply")).password, "applicant-two-secret");
  assert.equal(await vault.get("applicant-one", "https://other.example.com"), null);
  const files = await Promise.all(["applicant-one", "applicant-two"].map((id) => readFile(path.join(directory, `${id}.enc.json`), "utf8")));
  assert.ok(files.every((raw) => !raw.includes("secret") && !raw.includes("@example.test")));
  assert.notEqual(files[0], files[1]);
});

test("managed passwords are strong-looking random values", () => {
  const first = generateManagedPassword();
  const second = generateManagedPassword();
  assert.equal(first.length, 30);
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9!@#$%_-]+$/);
});
