import { realpath, stat, readFile } from "node:fs/promises";
import path from "node:path";
const extensions = new Set([".pdf", ".doc", ".docx", ".txt", ".rtf"]);
const contained = (root, file) => file === root || file.startsWith(root + path.sep);
export async function readSessionResume(profile, env = process.env) {
  const source = profile?.documents?.resume;
  if (typeof source !== "string" || !path.isAbsolute(source)) throw new Error("current resume needs an absolute private path");
  const roots = String(env.JOB_SERVER_ALLOWED_DOCUMENT_ROOTS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!roots.length) throw new Error("approved document roots required");
  const resolved = await realpath(source);
  const approved = await Promise.all(roots.map(root => realpath(root)));
  const metadata = await stat(resolved);
  if (!approved.some(root => contained(root, resolved)) || !metadata.isFile() || metadata.size < 1
    || metadata.size > 10 * 1024 * 1024 || !extensions.has(path.extname(resolved).toLowerCase())) throw new Error("invalid current resume file");
  return { filename: path.basename(resolved), bytes: await readFile(resolved) };
}
