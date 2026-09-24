import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const SAFE_NAMES = {
  resume: /^resume\.(pdf|doc|docx|odt|txt)$/i,
  coverLetter: /^cover-letter\.(pdf|doc|docx|odt|txt)$/i
};

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function validateWorkerPayload(payload, documentRoot) {
  const applicationId = payload?.application?.id;
  const profileId = payload?.profile?.id;
  if (!SAFE_ID.test(applicationId ?? "") || !SAFE_ID.test(profileId ?? "")) {
    throw Object.assign(new Error("worker payload has an invalid application or profile ID"), { status: 400 });
  }
  if (profileId !== payload.application.profileId) {
    throw Object.assign(new Error("worker payload has no matching profile"), { status: 400 });
  }
  // Pre-migration queued applications may carry the old automatic flag.
  // Without a versioned owner policy, exact final approval is mandatory.
  if (payload.application.standingPolicyVersion === undefined) {
    payload.application.finalApprovalRequired = true;
  }
  const root = await realpath(path.resolve(documentRoot)).catch(() => path.resolve(documentRoot));
  const applicationRoot = path.join(root, applicationId);
  for (const [role, value] of Object.entries(payload.profile.documents ?? {})) {
    if (!Object.hasOwn(SAFE_NAMES, role) || typeof value !== "string") {
      throw Object.assign(new Error(`unsupported worker document role: ${role}`), { status: 400 });
    }
    const resolved = await realpath(value).catch(() => { throw Object.assign(new Error(`staged ${role} does not exist`), { status: 400 }); });
    if (!contained(applicationRoot, resolved) || !SAFE_NAMES[role].test(path.basename(resolved))) {
      throw Object.assign(new Error(`staged ${role} is outside its application boundary`), { status: 400 });
    }
    const [link, metadata] = await Promise.all([lstat(value), stat(resolved)]);
    if (link.isSymbolicLink() || !metadata.isFile()) {
      throw Object.assign(new Error(`staged ${role} is not a regular file`), { status: 400 });
    }
    await access(resolved, constants.R_OK).catch(() => {
      throw Object.assign(new Error(`staged ${role} is not readable by the worker`), { status: 400 });
    });
    payload.profile.documents[role] = resolved;
  }
  return payload;
}
