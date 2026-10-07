import { randomUUID } from 'node:crypto';
import { ClientError } from '../service.js';

const LEASE_MS = 20 * 60_000;
const workers = new Set(['search-1', 'search-2']);
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

/** Search-only leases. This class cannot claim, fill, review or submit applications. */
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
    return session;
  }
  #lease(state, input, identity) {
    const session = this.#session(state, input, identity);
    if (!workers.has(input.workerId)) fail(400, 'workerId must be search-1 or search-2');
    const source = session.sources.find(item => item.lease?.id === input.leaseId && item.lease.workerId === input.workerId);
    if (!source) fail(409, 'search lease expired or was released; stop source work and claim again');
    return { session, source };
  }
  status(identity) {
    const session = this.store.snapshot().searchSessions?.find(item => item.profileId === identity.profileId);
    if (!session) return { session: null, workerCount: 2, timeZone: 'Europe/Sofia' };
    this.#refresh(session, this.clock());
    return { session, workerCount: 2, timeZone: 'Europe/Sofia' };
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
        return previous;
      }
      const session = { id: randomUUID(), profileId: identity.profileId, actorId: identity.actorId, sessionId,
        mode, active: true, day: dayAt(this.clock()), sources: input.sources.map(id => ({ id, status: 'ready',
          day: dayAt(this.clock()), cursor: null, reviewed: 0, strongMatches: 0, duplicates: 0, poorPages: 0 })) };
      if (previous) state.searchSessions.splice(state.searchSessions.indexOf(previous), 1, session);
      else state.searchSessions.push(session);
      this.#audit(state, session, identity, 'started', { workerCount: 2, sources: input.sources });
      return session;
    });
  }
  async claim(input, identity) {
    if (!workers.has(input.workerId)) fail(400, 'workerId must be search-1 or search-2');
    return this.store.mutate(state => {
      const session = this.#session(state, input, identity);
      let source = session.sources.find(item => item.lease?.workerId === input.workerId);
      if (!source) {
        source = session.sources.find(item => !item.lease && item.status === 'ready');
        if (!source) return { lease: null, day: session.day, reason: 'daily_pass_complete_or_sources_busy' };
        source.lease = { id: randomUUID(), workerId: input.workerId, day: session.day, expiresAt: this.clock() + LEASE_MS };
        this.#audit(state, session, identity, 'claimed', { sourceId: source.id, workerId: input.workerId, leaseId: source.lease.id });
      }
      return { lease: { ...source.lease, sourceId: source.id, cursor: source.cursor }, day: session.day };
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
      return { sourceId: source.id, lease: source.lease, moveOn: source.poorPages >= 2 };
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
      this.#audit(state, session, identity, 'stopped');
      return { stopped: true };
    });
  }
  async scan(input, identity, discovery, query = false) {
    const { session, source } = this.#lease(this.store.snapshot(), input, identity);
    const result = query ? await discovery.query({ ...input.query, source: source.id, mode: session.mode, reviewOnly: true }, identity)
      : await discovery.scan({ ...input.scan, sources: [source.id], mode: session.mode, reviewOnly: true }, identity);
    // A stopped/stale worker must not continue using the result.
    this.#lease(this.store.snapshot(), input, identity);
    return result;
  }
  async enqueue(input, identity, discovery) {
    const { session, source } = this.#lease(this.store.snapshot(), input, identity);
    if (input.candidate?.source !== source.id || input.fit?.decision !== 'relevant' || input.officialPostingReviewed !== true) {
      fail(400, 'review the full official posting and bind a relevant candidate to the leased source');
    }
    const considered = await discovery.considerCandidate({ candidate: input.candidate, fit: input.fit,
      mode: session.mode, apply: false }, identity);
    if (!['ready', 'destination_pending'].includes(considered.status)) return considered;
    const result = await this.service.chromeQueue.add({ opportunityId: considered.opportunityId }, identity,
      { authorize: state => this.#lease(state, input, identity) });
    return { status: result.duplicate ? 'already_queued' : 'queued', applicationId: result.application.id,
      opportunityId: considered.opportunityId, duplicate: result.duplicate };
  }
}
