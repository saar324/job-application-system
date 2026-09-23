// Browser discovery reports small, distinct batches so server-side screening,
// handled-role filtering, and the accepted limit decide when a source is done.
export class SourceProgress {
  constructor({ sourceId, maxAcceptedResults = 10, maxBatch = 10, report }) {
    this.sourceId = sourceId;
    this.maxAcceptedResults = maxAcceptedResults;
    this.maxBatch = maxBatch;
    this.report = report;
    this.seen = new Set();
    this.pending = [];
    this.found = 0;
    this.accepted = 0;
  }

  get done() { return this.accepted >= this.maxAcceptedResults; }

  async add(jobs) {
    for (const job of jobs) {
      if (this.done) break;
      if (!job?.title || !job?.company || !job?.applyUrl) continue;
      const key = String(job.externalId ?? job.listingUrl ?? job.applyUrl);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.pending.push(job);
      this.found += 1;
      if (this.pending.length >= this.maxBatch) await this.flush();
    }
  }

  async flush() {
    if (!this.pending.length || this.done) { this.pending = []; return; }
    const items = this.pending.splice(0);
    const campaign = await this.report(this.sourceId, items, { completed: false });
    this.accepted = campaign.sourceCoverage?.scans?.filter((scan) => scan.sourceId === this.sourceId)
      .reduce((sum, scan) => sum + Number(scan.selected ?? 0), 0) ?? 0;
  }

  async finish(metadata) {
    await this.flush();
    const campaign = await this.report(this.sourceId, [], { ...metadata, completed: true });
    this.accepted = campaign.sourceCoverage?.scans?.filter((scan) => scan.sourceId === this.sourceId)
      .reduce((sum, scan) => sum + Number(scan.selected ?? 0), 0) ?? 0;
    return campaign;
  }
}
