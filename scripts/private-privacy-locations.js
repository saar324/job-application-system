#!/usr/bin/env node
import { readFile } from "node:fs/promises";

// Temporary trusted diagnostic. Print positions only; never print a private
// denylist value or the matching source line.
const values = [...new Set(Buffer.from(process.env.PRIVACY_DENYLIST_B64 ?? "", "base64")
  .toString("utf8").split(/\r?\n/).map((value) => value.trim().toLocaleLowerCase("en-US"))
  .filter((value) => value.length >= 3))];
if (!values.length) throw new Error("private denylist is unavailable");

const files = ["CHANGELOG.md", "test/discovery.test.js", "test/efficiency-upgrade.test.js",
  "test/fixtures/ranking-evaluation.json"];
for (const file of files) {
  let contents;
  try { contents = await readFile(file, "utf8"); }
  catch { continue; }
  const lines = contents.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (values.some((value) => matches(line, value))) {
      console.log(`${file}:${index + 1}`);
    }
  }
}

function matches(line, value) {
  if (!/^[\p{L}\p{N}_-]+$/u.test(value)) return line.toLocaleLowerCase("en-US").includes(value);
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(line);
}
