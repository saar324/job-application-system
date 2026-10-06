export function patchOwnerSubmissionCollector(source) {
 if (source.includes("import { ownerSubmissionSentAt } from './owner-submission.mjs';")) return source;
 const receipt = ' if(receiptDate)return receiptDate;';
 const status = " const effectiveStatus=a=>displayStatus(sentDates.get(a.id)&&a.status==='skipped'";
 if (!source.includes(receipt) || !source.includes(status)) throw new Error('Unsupported collector version; no changes applied');
 return "import { ownerSubmissionSentAt } from './owner-submission.mjs';\n" + source
  .replace(receipt, receipt + '\n const ownerDate=ownerSubmissionSentAt(application,now);\n if(ownerDate)return ownerDate;')
  .replace(status," const effectiveStatus=a=>displayStatus(a.status==='owner_reported_submitted'&&sentDates.get(a.id)?(a.employerStatus?.status??'submitted'):sentDates.get(a.id)&&a.status==='skipped'");
}
