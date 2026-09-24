import { chmod, chown, copyFile, lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NeedsInputError } from "./adapters/errors.js";

const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const DEFAULT_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".odt", ".txt"]);

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export class DocumentPolicyError extends Error {}

export class DocumentStager {
  constructor({ sourceRoots, stagingRoot, maxBytes = 10 * 1024 * 1024, extensions = DEFAULT_EXTENSIONS }) {
    this.sourceRoots = sourceRoots.map((root) => path.resolve(root));
    this.stagingRoot = path.resolve(stagingRoot);
    this.maxBytes = maxBytes;
    this.extensions = new Set([...extensions].map((value) => value.toLowerCase()));
  }

  async stage(application, profile) {
    if (!SAFE_ID.test(application?.id ?? "")) throw new DocumentPolicyError("invalid application ID");
    const output = structuredClone(profile);
    output.documents = {};
    for (const [role, source] of Object.entries(profile?.documents ?? {})) {
      if (!source || !["resume", "coverLetter"].includes(role)) continue;
      try {
        output.documents[role] = await this.#stageOne(application.id, role, source);
      } catch (error) {
        throw new NeedsInputError("An application document needs attention", [{
          kind: "document_issue",
          message: `${role}: ${error.message}`,
          fields: [`documents.${role}`]
        }]);
      }
    }
    return output;
  }

  async #stageOne(applicationId, role, source) {
    if (typeof source !== "string" || !path.isAbsolute(source)) {
      throw new DocumentPolicyError("path must be absolute");
    }
    const resolved = await realpath(source).catch(() => { throw new DocumentPolicyError("file does not exist"); });
    const allowed = await Promise.all(this.sourceRoots.map(async (root) => realpath(root).catch(() => root)));
    if (!allowed.some((root) => contained(root, resolved))) {
      throw new DocumentPolicyError("file is outside the approved document roots");
    }
    const metadata = await stat(resolved);
    if (!metadata.isFile()) throw new DocumentPolicyError("path is not a regular file");
    if (metadata.size > this.maxBytes) throw new DocumentPolicyError(`file exceeds ${this.maxBytes} bytes`);
    const extension = path.extname(resolved).toLowerCase();
    if (!this.extensions.has(extension)) throw new DocumentPolicyError(`unsupported file extension: ${extension || "none"}`);

    const directory = path.join(this.stagingRoot, applicationId);
    await mkdir(directory, { recursive: true, mode: 0o2750 });
    const groupId = (await stat(this.stagingRoot)).gid;
    const directoryEntry = await lstat(directory);
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
      throw new DocumentPolicyError("staging directory is not a regular directory");
    }
    if (directoryEntry.gid !== groupId) await chown(directory, directoryEntry.uid, groupId);
    await chmod(directory, 0o2750);
    const destination = path.join(directory, `${role === "coverLetter" ? "cover-letter" : "resume"}${extension}`);
    await copyFile(resolved, destination);
    const entry = await lstat(destination);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new DocumentPolicyError("staged document is not a regular file");
    }
    // copyFile can preserve a private source's 0600 mode and primary group.
    // The API and worker are separate users sharing the staging root's group.
    if (entry.gid !== groupId) await chown(destination, entry.uid, groupId);
    await chmod(destination, 0o640);
    return destination;
  }
}

export function documentStagerFromEnv(env = process.env) {
  const stagingRoot = env.JOB_SERVER_DOCUMENT_STAGING;
  const sourceRoots = String(env.JOB_SERVER_ALLOWED_DOCUMENT_ROOTS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (!stagingRoot || !sourceRoots.length) {
    throw new Error("JOB_SERVER_DOCUMENT_STAGING and JOB_SERVER_ALLOWED_DOCUMENT_ROOTS are required for webhook execution");
  }
  const maxBytes = Number(env.JOB_SERVER_DOCUMENT_MAX_BYTES ?? 10 * 1024 * 1024);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("JOB_SERVER_DOCUMENT_MAX_BYTES must be a positive integer");
  return new DocumentStager({ sourceRoots, stagingRoot, maxBytes });
}
