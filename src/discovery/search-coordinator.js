import { randomUUID } from 'node:crypto';
import { ClientError } from '../service.js';
import { saveDraft, validateDraft, draftFingerprint, draftProfileFingerprint } from '../application-drafts.js';

const LEASE_MS = 20 * 60_000;
const workers = new Set(['search-1', 'search-2']);
const pending = (state, profileId) => state.applications.filter(a => a.profileId === profileId
  && a.executionMode === 'chrome_session' && a.status === 'pending');
const fail = (code, message) => { throw new ClientError(code, message); };
const dayAt = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
const bounded = (value, name, max = 100) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `${name} must be bounded text`);
  return value.trim();
};
const integer = (value, name) => {
  if (!Number.isInteger(value) || value < 0 || value > 10000) fail(400, `${name} must be a bounded nonnegative integer`);
  return value;
};

/** Passive search and preparation leases. Never fills or submits employer forms. */
export class SearchCoordinator {
  constructor(service, { clock = () => Date.now() } = {}) { this.service = service; this.store = service.store; this.clock = clock; }
  #audit(state, session, identity, action, details = {}) {
    state.audit.push({ id: randomUUID(), profileId: identity.profileId, actorId: identity.actorId,
      action: `discovery.search_${action}`, subjectId: session.id, at: new Date(this.clock()).toISOString(), details });
  }
  #refresh(session, at) {
    const day = dayAt(at);
    if (session.day !== day) {
      session.day = day;
      for (const source of session.sources) {
        source.day = day; source.status = 'ready'; source.cursor = null;
        source.reviewed = 0; source.strongMatches = 0; source.duplicates = 0; source.poorPages = 0;
        delete source.reason;
        // Retain a live old-day lease until it is finished or expires. Midnight must not create overlap.
      }
    }
    for (const source of session.sources) if (source.lease && source.lease.expiresAt <= at) delete source.lease;
  }
  #session(state, input, identity) {
    const sessionId = bounded(input.sessionId, 'sessionId');
    const session = state.searchSessions?.find(item => item.profileId === identity.profileId);
    if (!session || !session.active) fail(409, 'search session is not active');
    if (session.sessionId !== sessionId || session.actorId !== identity.actorId) fail(409, 'another main session owns search');
    this.#refresh(session, this.clock());
    this.#buffer(state, session);
    return session;
  }
  #buffer(state, session) {
    const count = pending(state, session.profileId).length;
    session.buffer ??= { lowWatermark: 20, highWatermark: 30, refilling: false, cycle: 0 };
    if (count >= 30) session.buffer.refilling = false;
    else if (count <= 20 && !session.buffer.refilling) { session.buffer.refilling = true; session.buffer.cycle += 1; }
    const draftMissing = pending(state, session.profileId).filter(a => !a.preparation).length;
    return { ...session.buffer, pending: count, draftMissing, shouldSearch: session.active && session.buffer.refilling,
      shouldStartWorkers: session.active && session.buffer.refilling,
      shouldPrepare: session.active && session.buffer.refilling && draftMissing > 0,
      shouldStopWorkers: !session.active || !session.buffer.refilling };
  }
  #searchAllowed(state, session) {
    const buffer = this.#buffer(state, session);
    if (!buffer.shouldSearch) fail(409, 'queue buffer full or waiting for low watermark; finish source and stop searching');
    return buffer;
  }
  #lease(state, input, identity) {
    const session = this.#session(state, input, identity);
    if (!workers.has(input.workerId)) fail(400, 'workerId must be search-1 or search-2');
    const source = session.sources.find(item => item.lease?.id === input.leaseId && item.lease.workerId === input.workerId);
    if (!source) fail(409, 'search lease expired or was released; stop source work and claim again');
    return { session, source };
  }
  status(identity) {
    const state = this.store.snapshot();
    const session = state.searchSessions?.find(item => item.profileId === identity.profileId);
    if (!session) return { session: null, workerCount: 2, timeZone: 'Europe/Sofia' };
    this.#refresh(session, this.clock());
    return { session, buffer: this.#buffer(state, session), workerCount: 2, timeZone: 'Europe/Sofia' };
  }
  async control(input, identity) {
    return this.store.mutate(state => {
      const session = this.#session(state, input, identity);
      return { buffer: this.#buffer(state, session), workerCount: 2, sessionId: session.sessionId };
    });
  }
  async start(input, identity) {
    const sessionId = bounded(input.sessionId, 'sessionId');
    if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 100
      || input.sources.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(id)
        || /linkedin|direct.*outreach/i.test(id)) || new Set(input.sources).size !== input.sources.length) {
      fail(400, 'ordered unique public search source IDs required; no LinkedIn or outreach');
    }
    const mode = input.mode ?? this.service.config.defaultMode;
    if (!this.service.config.modes[mode]) fail(400, 'unknown mode');
    return this.store.mutate(state => {
      state.searchSessions ??= [];
      const previous = state.searchSessions.find(item => item.profileId === identity.profileId);
      if (previous?.active) {
        this.#refresh(previous, this.clock());
        if (previous.sessionId !== sessionId || previous.actorId !== identity.actorId) fail(409, 'stop the previous main search session before takeover');
        if (JSON.stringify(previous.sources.map(item => item.id)) !== JSON.stringify(input.sources) || previous.mode !== mode) {
          fail(409, 'stop search before changing source order or mode');
        }
        this.#buffer(state, previous);
        return previous;
      }
      const session = { id: randomUUID(), profileId: identity.profileId, actorId: identity.actorId, sessionId,
        mode, active: true, day: dayAt(this.clock()), sources: input.sources.map(id => ({ id, status: 'ready',
          day: dayAt(this.clock()), cursor: null, reviewed: 0, strongMatches: 0, duplicates: 0, poorPages: 0 })) };
      if (previous) state.searchSessions.splice(state.searchSessions.indexOf(previous), 1, session);
      else state.searchSessions.push(session);
      this.#buffer(state, session);
      this.#audit(state, session, identity, 'started', { workerCount: 2, sources: input.sources });
      return session;
    });
  }
  async claim(input, identity) {
    if (!workers.has(input.workerId)) fail(400, 'workerId must be search-1 or search-2');
    return this.store.mutate(state => {
      const session = this.#session(state, input, identity);
      const buffer = this.#buffer(state, session);
      if (!buffer.shouldSearch) return { lease: null, day: session.day, reason: 'buffer_satisfied', buffer };
      let source = session.sources.find(item => item.lease?.workerId === input.workerId);
      if (!source) {
        source = session.sources.find(item => !item.lease && item.status === 'ready');
        if (!source) return { lease: null, day: session.day, reason: 'daily_pass_complete_or_sources_busy' };
        source.lease = { id: randomUUID(), workerId: input.workerId, day: session.day, expiresAt: this.clock() + LEASE_MS };
        this.#audit(state, session, identity, 'claimed', { sourceId: source.id, workerId: input.workerId, leaseId: source.lease.id });
      }
      return { lease: { ...source.lease, sourceId: source.id, cursor: source.cursor }, day: session.day, buffer };
    });
  }
  async progress(input, identity) {
    const reviewed = integer(input.reviewed ?? 0, 'reviewed');
    const strongMatches = integer(input.strongMatches ?? 0, 'strongMatches');
    const duplicates = integer(input.duplicates ?? 0, 'duplicates');
    if (strongMatches + duplicates > reviewed) fail(400, 'match and duplicate counts cannot exceed reviewed count');
    if (input.cursor !== undefined && input.cursor !== null) bounded(input.cursor, 'cursor', 2000);
    return this.store.mutate(state => {
      const { session, source } = this.#lease(state, input, identity);
      source.lease.expiresAt = this.clock() + LEASE_MS;
      // An old-day worker may finish safely, but cannot replace the new day's cursor/counters.
      if (source.lease.day === session.day) {
        source.reviewed += reviewed; source.strongMatches += strongMatches; source.duplicates += duplicates;
        if (input.pageComplete === true) source.poorPages = strongMatches ? 0 : source.poorPages + 1;
        if (input.cursor !== undefined) source.cursor = input.cursor;
      }
      const buffer = this.#buffer(state, session);
      return { sourceId: source.id, lease: source.lease, moveOn: source.poorPages >= 2, stop: !buffer.shouldSearch, buffer };
    });
  }
  async finish(input, identity) {
    if (!['low_quality', 'pass_complete', 'blocked', 'paused'].includes(input.outcome)) fail(400, 'bounded source pass outcome required');
    const reason = bounded(input.reason, 'reason', 500);
    return this.store.mutate(state => {
      const { session, source } = this.#lease(state, input, identity);
      if (input.outcome === 'low_quality' && source.lease.day === session.day && source.poorPages < 2) fail(400, 'two focused pages without unseen strong matches are required for low_quality');
      if (source.lease.day === session.day) {
        source.status = input.outcome === 'paused' ? 'ready' : input.outcome; source.reason = reason;
      }
      this.#audit(state, session, identity, 'finished', { sourceId: source.id, workerId: input.workerId, outcome: input.outcome, reason });
      delete source.lease;
      return { sourceId: source.id, status: source.status, day: session.day };
    });
  }
  async stop(input, identity) {
    return this.store.mutate(state => {
      const session = this.#session(state, input, identity);
      session.active = false;
      for (const source of session.sources) delete source.lease;
      for (const item of pending(state, identity.profileId)) delete item.preparationLease;
      this.#audit(state, session, identity, 'stopped');
      return { stopped: true };
    });
  }
  async scan(input, identity, discovery, query = false) {
    const state = this.store.snapshot(), { session, source } = this.#lease(state, input, identity);
    this.#searchAllowed(state, session);
    const result = query ? await discovery.query({ ...input.query, source: source.id, mode: session.mode, reviewOnly: true }, identity)
      : await discovery.scan({ ...input.scan, sources: [source.id], mode: session.mode, reviewOnly: true }, identity);
    // A stopped/stale worker must not continue using the result.
    this.#lease(this.store.snapshot(), input, identity);
    const latest = this.store.snapshot(); this.#searchAllowed(latest, this.#session(latest, input, identity));
    return result;
  }
  async enqueue(input, identity, discovery) {
    const state = this.store.snapshot(), { session, source } = this.#lease(state, input, identity);
    this.#searchAllowed(state, session);
    if (input.candidate?.source !== source.id || input.fit?.decision !== 'relevant' || input.officialPostingReviewed !== true) {
      fail(400, 'review the full official posting and bind a relevant candidate to the leased source');
    }
    const packet = validateDraft(input.draft), profile = await this.service.profiles.get(identity.profileId);
    if (input.profileFingerprint !== draftProfileFingerprint(profile)) fail(409, 'reload draft context: applicant facts changed');
    const considered = await discovery.considerCandidate({ candidate: input.candidate, fit: input.fit,
      mode: session.mode, apply: false }, identity);
    if (!['ready', 'destination_pending'].includes(considered.status)) return considered;
    const result = await this.service.chromeQueue.add({ opportunityId: considered.opportunityId }, identity,
      { authorize: state => { const { session } = this.#lease(state, input, identity); this.#searchAllowed(state, session); },
        prepare: (state, item, duplicate) => {
          if (!duplicate) saveDraft(item, state.opportunities.find(o => o.id === item.opportunityId && o.profileId === identity.profileId),
            packet, profile, { sessionId: input.sessionId, workerId: input.workerId }, new Date(this.clock()).toISOString());
          this.#buffer(state, this.#session(state, input, identity));
        } });
    return { status: result.duplicate ? 'already_queued' : 'queued', applicationId: result.application.id,
      opportunityId: considered.opportunityId, duplicate: result.duplicate, buffer: this.status(identity).buffer };
  }
  async prepareClaim(input, identity) {
    if (!workers.has(input.workerId)) fail(400, 'workerId must be search-1 or search-2');
    const profile = await this.service.profiles.get(identity.profileId);
    return this.store.mutate(state => {
      const session = this.#session(state, input, identity), at = this.clock();
      if (!this.#buffer(state, session).shouldSearch) return { lease: null, reason: 'buffer_satisfied', buffer: this.#buffer(state, session) };
      const items = pending(state, identity.profileId).sort((a,b) => a.queuePosition - b.queuePosition);
      for (const a of items) if (a.preparationLease?.expiresAt <= at) delete a.preparationLease;
      let item = items.find(a => a.preparationLease?.workerId === input.workerId && a.preparationLease?.sessionId === input.sessionId);
      if (!item) item = items.find(a => !a.preparationLease && (!a.preparation
        || JSON.stringify(a.preparation.fingerprint) !== JSON.stringify(draftFingerprint(profile, state.opportunities.find(o => o.id === a.opportunityId && o.profileId === identity.profileId)))));
      if (!item) return { lease: null, reason: 'no_draft_backlog_or_busy', buffer: this.#buffer(state, session) };
      item.preparationLease ??= { id: randomUUID(), workerId: input.workerId, sessionId: input.sessionId, expiresAt: at + LEASE_MS };
      item.preparationLease.expiresAt = at + LEASE_MS;
      return { applicationId: item.id, lease: item.preparationLease,
        opportunity: state.opportunities.find(o => o.id === item.opportunityId && o.profileId === identity.profileId),
        profileFingerprint: draftProfileFingerprint(profile), buffer: this.#buffer(state, session) };
    });
  }
  async prepareSave(input, identity) {
    const packet = validateDraft(input.draft), profile = await this.service.profiles.get(identity.profileId);
    if (input.profileFingerprint !== draftProfileFingerprint(profile)) fail(409, 'reload draft context: applicant facts changed');
    return this.store.mutate(state => {
      const session = this.#session(state, input, identity);
      const item = pending(state, identity.profileId).find(a => a.id === input.applicationId);
      const lease = item?.preparationLease;
      if (!workers.has(input.workerId) || !lease || lease.id !== input.leaseId || lease.workerId !== input.workerId
        || lease.sessionId !== input.sessionId || lease.expiresAt <= this.clock()) fail(409, 'preparation lease expired or application already claimed');
      saveDraft(item, state.opportunities.find(o => o.id === item.opportunityId && o.profileId === identity.profileId), packet, profile,
        { sessionId: input.sessionId, workerId: input.workerId }, new Date(this.clock()).toISOString());
      return { applicationId: item.id, revision: item.preparation.revision, status: 'unreviewed', buffer: this.#buffer(state, session) };
    });
  }
}
