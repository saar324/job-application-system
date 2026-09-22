import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export const EMPTY_STATE = Object.freeze({
  opportunities: [], applications: [], confirmations: [], audit: [], attempts: []
});

export class SqliteStore {
  #file;
  #db;
  #pending = Promise.resolve();

  constructor(file, { busyTimeoutMs = 5_000 } = {}) {
    this.#file = path.resolve(file);
    this.busyTimeoutMs = busyTimeoutMs;
  }

  get file() { return this.#file; }
  get kind() { return "sqlite"; }

  async init() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    this.#db = new DatabaseSync(this.#file, { timeout: this.busyTimeoutMs });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${Math.max(1, Number(this.busyTimeoutMs) || 5_000)};
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        dedup_key TEXT,
        apply_url TEXT,
        created_at TEXT,
        payload TEXT NOT NULL,
        UNIQUE(profile_id, dedup_key)
      );
      CREATE INDEX IF NOT EXISTS opportunities_profile_url
        ON opportunities(profile_id, apply_url);
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE RESTRICT,
        status TEXT NOT NULL,
        mode TEXT,
        created_at TEXT,
        updated_at TEXT,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS applications_profile_status
        ON applications(profile_id, status, created_at);
      CREATE TABLE IF NOT EXISTS confirmations (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        kind TEXT,
        created_at TEXT,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS confirmations_application_status
        ON confirmations(application_id, status);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        claimed_at TEXT,
        lease_expires_at TEXT,
        execution_started_at TEXT,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attempts_application_status
        ON attempts(application_id, status);
      CREATE TABLE IF NOT EXISTS receipts (
        application_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
        submitted_at TEXT,
        final_url TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        subject_id TEXT,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_profile_at ON audit_events(profile_id, at);
      CREATE TABLE IF NOT EXISTS idempotency_records (
        profile_id TEXT NOT NULL,
        action TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        response TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY(profile_id, action, idempotency_key)
      );
    `);
    this.#db.prepare(
      "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)"
    ).run(1, new Date().toISOString());
    this.#db.prepare(
      "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)"
    ).run(2, new Date().toISOString());
    this.#db.prepare("INSERT OR IGNORE INTO runtime_metadata(key, value) VALUES ('state_revision', '0')").run();
    const integrity = this.#db.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") throw new Error(`SQLite integrity check failed: ${integrity.integrity_check}`);
    return this;
  }

  schemaVersion() {
    return Number(this.#db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0);
  }

  metadata(key) {
    return this.#db.prepare("SELECT value FROM runtime_metadata WHERE key = ?").get(key)?.value;
  }

  importLegacyState(state, markerKey, markerValue) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (this.metadata(markerKey) !== undefined) {
        this.#db.exec("COMMIT");
        return false;
      }
      const current = this.#readState();
      const normalized = {
        opportunities: state.opportunities ?? [], applications: state.applications ?? [],
        confirmations: state.confirmations ?? [], audit: state.audit ?? [], attempts: state.attempts ?? []
      };
      const currentCount = Object.values(current).reduce((sum, items) => sum + items.length, 0);
      if (currentCount > 0 && JSON.stringify(current) !== JSON.stringify(normalized)) {
        throw new Error("SQLite contains unmarked state that differs from the legacy JSON; refusing to overwrite it");
      }
      if (currentCount === 0) this.#writeState(normalized, current);
      this.#db.prepare("INSERT INTO runtime_metadata(key, value) VALUES (?, ?)").run(markerKey, markerValue);
      this.#db.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  reserveIdempotency({ profileId, action, key, requestHash }) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db.prepare(`
        SELECT request_hash AS requestHash, status, response
        FROM idempotency_records WHERE profile_id = ? AND action = ? AND idempotency_key = ?
      `).get(profileId, action, key);
      if (existing) {
        this.#db.exec("COMMIT");
        return { state: existing.status, requestHash: existing.requestHash,
          ...(existing.response ? { response: JSON.parse(existing.response) } : {}) };
      }
      this.#db.prepare(`
        INSERT INTO idempotency_records(profile_id, action, idempotency_key, request_hash, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `).run(profileId, action, key, requestHash, new Date().toISOString());
      this.#db.exec("COMMIT");
      return { state: "reserved", requestHash };
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  getIdempotency({ profileId, action, key }) {
    const existing = this.#db.prepare(`
      SELECT request_hash AS requestHash, status, response
      FROM idempotency_records WHERE profile_id = ? AND action = ? AND idempotency_key = ?
    `).get(profileId, action, key);
    return existing ? { state: existing.status, requestHash: existing.requestHash,
      ...(existing.response ? { response: JSON.parse(existing.response) } : {}) } : null;
  }

  completeIdempotency({ profileId, action, key, requestHash, response }) {
    const completedAt = new Date().toISOString();
    const result = this.#db.prepare(`
      UPDATE idempotency_records SET status = 'completed', response = ?, completed_at = ?
      WHERE profile_id = ? AND action = ? AND idempotency_key = ?
        AND request_hash = ? AND status = 'pending'
    `).run(JSON.stringify(response), completedAt, profileId, action, key, requestHash);
    if (result.changes !== 1) throw new Error("idempotency reservation was lost before completion");
  }

  abortIdempotency({ profileId, action, key, requestHash }) {
    this.#db.prepare(`
      DELETE FROM idempotency_records
      WHERE profile_id = ? AND action = ? AND idempotency_key = ?
        AND request_hash = ? AND status = 'pending'
    `).run(profileId, action, key, requestHash);
  }

  snapshot() {
    this.#db.exec("BEGIN");
    try {
      const state = this.#readState();
      this.#db.exec("COMMIT");
      return state;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  #readState() {
    const parseRows = (table) => this.#db.prepare(`SELECT payload FROM ${table} ORDER BY rowid`)
      .all().map((row) => JSON.parse(row.payload));
    return {
      opportunities: parseRows("opportunities"),
      applications: parseRows("applications"),
      confirmations: parseRows("confirmations"),
      audit: parseRows("audit_events"),
      attempts: parseRows("attempts")
    };
  }

  async mutate(fn) {
    const operation = this.#pending.then(async () => {
      for (let retry = 0; retry < 20; retry += 1) {
        this.#db.exec("BEGIN");
        const revision = Number(this.#db.prepare(
          "SELECT value FROM runtime_metadata WHERE key = 'state_revision'"
        ).get().value);
        const draft = this.#readState();
        const original = structuredClone(draft);
        this.#db.exec("COMMIT");
        const result = await fn(draft);
        this.#db.exec("BEGIN IMMEDIATE");
        try {
          const current = Number(this.#db.prepare(
            "SELECT value FROM runtime_metadata WHERE key = 'state_revision'"
          ).get().value);
          if (current !== revision) {
            this.#db.exec("ROLLBACK");
            continue;
          }
          this.#writeState(draft, original);
          this.#db.prepare("UPDATE runtime_metadata SET value = ? WHERE key = 'state_revision'")
            .run(String(revision + 1));
          this.#db.exec("COMMIT");
          return structuredClone(result);
        } catch (error) {
          try { this.#db.exec("ROLLBACK"); } catch {}
          throw error;
        }
      }
      throw new Error("SQLite state changed too frequently; retry the operation");
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  close() { this.#db?.close(); }

  #writeState(state, original = EMPTY_STATE) {
    for (const key of ["opportunities", "applications", "confirmations", "audit", "attempts"]) {
      if (!Array.isArray(state[key])) throw new Error(`state.${key} must be an array`);
    }
    const profiles = new Set();
    for (const collection of [state.opportunities, state.applications, state.confirmations, state.audit, state.attempts]) {
      for (const item of collection) if (item.profileId) profiles.add(item.profileId);
    }
    const createdAt = new Date().toISOString();
    const insertProfile = this.#db.prepare("INSERT OR IGNORE INTO profiles(id, created_at) VALUES (?, ?)");
    for (const id of profiles) insertProfile.run(id, createdAt);

    const changed = (collection, previous) => {
      const before = new Map((previous ?? []).map((item) => [item.id, JSON.stringify(item)]));
      return collection.filter((item) => before.get(item.id) !== JSON.stringify(item));
    };
    const removeMissing = (table, collection, previous) => {
      const retained = new Set(collection.map((item) => item.id));
      const remove = this.#db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      for (const item of previous ?? []) if (!retained.has(item.id)) remove.run(item.id);
    };

    removeMissing("confirmations", state.confirmations, original.confirmations);
    removeMissing("attempts", state.attempts, original.attempts);
    removeMissing("applications", state.applications, original.applications);
    removeMissing("opportunities", state.opportunities, original.opportunities);
    removeMissing("audit_events", state.audit, original.audit);

    const insertOpportunity = this.#db.prepare(`
      INSERT INTO opportunities(id, profile_id, dedup_key, apply_url, created_at, payload)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id, dedup_key=excluded.dedup_key,
        apply_url=excluded.apply_url, created_at=excluded.created_at, payload=excluded.payload
    `);
    for (const item of changed(state.opportunities, original.opportunities)) insertOpportunity.run(
      item.id, item.profileId, item.dedupKey ?? null, item.applyUrl ?? null, item.createdAt ?? null, JSON.stringify(item)
    );

    const insertApplication = this.#db.prepare(`
      INSERT INTO applications(id, profile_id, opportunity_id, status, mode, created_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id, opportunity_id=excluded.opportunity_id,
        status=excluded.status, mode=excluded.mode, created_at=excluded.created_at,
        updated_at=excluded.updated_at, payload=excluded.payload
    `);
    const insertReceipt = this.#db.prepare(`
      INSERT INTO receipts(application_id, submitted_at, final_url, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(application_id) DO UPDATE SET submitted_at=excluded.submitted_at,
        final_url=excluded.final_url, payload=excluded.payload
    `);
    for (const item of changed(state.applications, original.applications)) {
      insertApplication.run(item.id, item.profileId, item.opportunityId, item.status, item.mode ?? null,
        item.createdAt ?? null, item.updatedAt ?? null, JSON.stringify(item));
      if (item.receipt) insertReceipt.run(item.id, item.receipt.submittedAt ?? null,
        item.receipt.finalUrl ?? null, JSON.stringify(item.receipt));
      else this.#db.prepare("DELETE FROM receipts WHERE application_id = ?").run(item.id);
    }

    const insertConfirmation = this.#db.prepare(`
      INSERT INTO confirmations(id, profile_id, application_id, status, kind, created_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id, application_id=excluded.application_id,
        status=excluded.status, kind=excluded.kind, created_at=excluded.created_at, payload=excluded.payload
    `);
    for (const item of changed(state.confirmations, original.confirmations)) insertConfirmation.run(
      item.id, item.profileId, item.applicationId, item.status, item.kind ?? null,
      item.createdAt ?? null, JSON.stringify(item)
    );

    const insertAttempt = this.#db.prepare(`
      INSERT INTO attempts(id, profile_id, application_id, status, claimed_at, lease_expires_at, execution_started_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id, application_id=excluded.application_id,
        status=excluded.status, claimed_at=excluded.claimed_at, lease_expires_at=excluded.lease_expires_at,
        execution_started_at=excluded.execution_started_at, payload=excluded.payload
    `);
    for (const item of changed(state.attempts, original.attempts)) insertAttempt.run(
      item.id, item.profileId, item.applicationId, item.status, item.claimedAt ?? null,
      item.leaseExpiresAt ?? null, item.executionStartedAt ?? null, JSON.stringify(item)
    );

    const insertAudit = this.#db.prepare(`
      INSERT INTO audit_events(id, profile_id, at, action, subject_id, payload)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id, at=excluded.at,
        action=excluded.action, subject_id=excluded.subject_id, payload=excluded.payload
    `);
    for (const item of changed(state.audit, original.audit)) insertAudit.run(
      item.id, item.profileId, item.at, item.action, item.subjectId ?? null, JSON.stringify(item)
    );

    this.#db.exec(`DELETE FROM profiles WHERE id NOT IN (
      SELECT profile_id FROM opportunities UNION SELECT profile_id FROM applications
      UNION SELECT profile_id FROM confirmations UNION SELECT profile_id FROM attempts
      UNION SELECT profile_id FROM audit_events
    )`);
  }
}

export function validateStateRelationships(state) {
  for (const key of ["opportunities", "applications", "confirmations", "audit"]) {
    if (!Array.isArray(state?.[key])) throw new Error(`state.${key} must be an array`);
  }
  if (state.attempts !== undefined && !Array.isArray(state.attempts)) throw new Error("state.attempts must be an array");
  for (const key of ["opportunities", "applications", "confirmations", "audit", "attempts"]) {
    const ids = (state[key] ?? []).map((item) => item.id);
    if (ids.some((id) => !id)) throw new Error(`state.${key} contains a record without an id`);
    if (new Set(ids).size !== ids.length) throw new Error(`state.${key} contains duplicate ids`);
  }
  const opportunities = new Map(state.opportunities.map((item) => [item.id, item]));
  const applications = new Map(state.applications.map((item) => [item.id, item]));
  for (const item of state.applications) {
    const opportunity = opportunities.get(item.opportunityId);
    if (!opportunity) throw new Error(`application ${item.id} has no opportunity`);
    if (opportunity.profileId !== item.profileId) throw new Error(`application ${item.id} crosses profile ownership`);
  }
  for (const item of state.confirmations) {
    const application = applications.get(item.applicationId);
    if (!application) throw new Error(`confirmation ${item.id} has no application`);
    if (application.profileId !== item.profileId) throw new Error(`confirmation ${item.id} crosses profile ownership`);
  }
  for (const item of state.attempts ?? []) {
    const application = applications.get(item.applicationId);
    if (!application) throw new Error(`attempt ${item.id} has no application`);
    if (application.profileId !== item.profileId) throw new Error(`attempt ${item.id} crosses profile ownership`);
  }
  return {
    opportunities: state.opportunities.length,
    applications: state.applications.length,
    confirmations: state.confirmations.length,
    audit: state.audit.length,
    attempts: state.attempts?.length ?? 0
  };
}
