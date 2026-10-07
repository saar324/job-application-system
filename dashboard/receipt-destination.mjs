// The API creates destinationVerification after checking the official ATS page.
// Clients cannot substitute an unchecked origin assertion for this evidence.
export function receiptDestinationMatches(destination, finalUrl, verification, now = new Date()) {
 try {
  const source = new URL(destination), final = new URL(finalUrl);
  if ([source, final].some(u => u.protocol !== 'https:' || u.username || u.password)) return false;
  if (source.origin === final.origin) return true;
  return verification?.kind === 'official_ats_employer_link'
   && verification.sourceUrl === source.href && verification.finalUrl === final.href
   && verification.employerOrigin === final.origin
   && typeof verification.linkText === 'string' && !!verification.linkText.trim()
   && /^[a-f0-9]{64}$/.test(verification.sourceContentHash ?? '')
   && Number.isFinite(Date.parse(verification.verifiedAt))
   && Date.parse(verification.verifiedAt) <= now.getTime();
 } catch { return false; }
}
