import { plainText } from "./text.js";

// Greenhouse has no reliable remote boolean. Use only explicit wording from
// the current employer posting; an aggregator's remote label is never proof.
export function greenhouseRemoteRole(row) {
  const title = String(row?.title ?? "");
  const location = String(row?.location?.name ?? "");
  const content = plainText(row?.content ?? "");
  // In-person team gatherings do not make an otherwise fully remote role
  // onsite. Keep actual hybrid/office work requirements as blockers.
  const statement = `${title} ${location} ${content}`.replace(
    /\b(?:onsite|on-site|in-office) (?:team |company |global )?(?:events?|offsites?|retreats?|meetups?|gatherings?)\b/gi, "");
  if (/\b(?:hybrid|on[- ]?site|in[- ]office|office[- ]based)\b/i.test(statement)
    || /\b(?:not|no) (?:a |an )?(?:(?:fully|100%) )?remote\b/i.test(statement)
    || /\bremote work (?:is )?(?:not available|not offered|only occasionally)\b/i.test(statement)
    || /\bremote (?:roles?|positions?|jobs?|work|working) (?:is |are )?(?:not available|not offered|unavailable)\b/i.test(statement)
    || /\bmust (?:work|be) (?:from|in|at) (?:the|our|an?) office\b/i.test(statement)) return false;
  return /\b(remote|distributed|work from home)\b/i.test(location)
    || /(?:\(\s*remote\s*\)|\[\s*remote\s*\]|[-–—]\s*remote\s*$|^remote\s*[-:])/i.test(title)
    || /#LI[-_]REMOTE\b/i.test(content)
    || /\b(?:fully|100%|entirely|exclusively) remote\b/i.test(content)
    || /\bremote[- ]first\b/i.test(content)
    || /\bremote (?:role|position|job)\b/i.test(content)
    || /\b(?:work|working) remotely (?:from|within|across|anywhere)\b/i.test(content);
}
