// The posting API can omit its nullable boolean. Only an explicit role location
// can fill that gap; company-wide remote prose is never a substitute.
export function ashbyRemoteRole(row) {
  const location = String(row?.location ?? '');
  const workplace = String(row?.workplaceType ?? '');
  const statement = `${location} ${row?.descriptionPlain ?? ''}`.replace(/\b(?:onsite|on-site|in-office) (?:team |company |global )?(?:events?|offsites?|retreats?|meetups?|gatherings?)\b/gi,'');
  if (row?.isRemote === false || /hybrid|on[- ]?site|in[- ]office|office[- ]based/i.test(workplace)
    || /\b(?:hybrid|on[- ]?site|in[- ]office|office[- ]based)\b/i.test(location)
    || /\bhybrid (?:role|position|work|working|schedule|model)\b/i.test(statement)
    || /\b(?:role|position|workplace|work schedule) (?:is|will be) (?:hybrid|on[- ]?site|in[- ]office)\b/i.test(statement)
    || /\b(?:onsite|on-site|in-office|office-based) (?:role|position|work|working)\b/i.test(statement)
    || /\b(?:not|no) (?:a |an )?(?:(?:fully|100%) )?remote\b/i.test(statement)
    || /\bmust (?:work|be) (?:from|in|at) (?:the|our|an?) office\b/i.test(statement)) return false;
  return row?.isRemote === true || (row?.isRemote == null && /\bremote\b/i.test(location));
}
