import { randomUUID } from 'node:crypto';
import { ClientError } from './service.js';
import { normalizeCredentialOrigin } from './credential-vault.js';

const fail = (status, message) => { throw new ClientError(status, message); };
/** Credential transport only. The owner chat remains the sole browser operator. */
export class AccountAccess {
  constructor(service, vault) { this.service = service; this.vault = vault; }
  scope(id, input, identity, action) {
    const allowed = action === 'store' ? ['sessionId', 'origin', 'username', 'password', 'storageAuthorization'] : ['sessionId', 'origin'];
    if (!input || Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'unsupported account request fields');
    const current = this.service.chromeQueue.list(identity.profileId).current;
    if (!current || current.id !== id) fail(404, 'current applicant application not found');
    if (!input.sessionId || current.sessionId !== input.sessionId || current.sessionActorId !== identity.actorId) fail(409, 'session does not own this application');
    if (!['in_progress', 'waiting_owner'].includes(current.status) || current.finalAction || current.legacyOutcomeHold) fail(409, 'account access cannot clear an uncertain application outcome');
    let expected, requested;
    try { expected = normalizeCredentialOrigin(current.opportunity.applyUrl); requested = normalizeCredentialOrigin(input.origin); }
    catch { fail(400, 'account origin must be public HTTPS'); }
    if (expected !== requested) fail(409, 'account origin does not match the current official application');
    return { current, origin: requested };
  }
  async run(action, id, input, identity) {
    const { origin } = this.scope(id, input, identity, action);
    const configured = this.vault?.configured(identity.profileId) === true;
    if (!configured) {
      if (action === 'status') return { configured: false, available: false, origin };
      fail(503, 'encrypted account vault is not configured for this applicant');
    }
    let result;
    if (action === 'store') {
      if (typeof input.storageAuthorization !== 'string' || input.storageAuthorization.trim().length < 8
        || input.storageAuthorization.length > 1000) fail(400, 'explicit owner storage authorization is required');
      try { result = await this.vault.save(identity.profileId, origin, { username: input.username, password: input.password }); }
      catch (error) { fail(error.status ?? 400, error.status === 409 ? 'existing account credential requires owner-managed update' : 'account credential could not be stored'); }
    } else {
      let credential;
      try { credential = await this.vault.get(identity.profileId, origin); }
      catch { fail(503, 'encrypted account vault could not be unlocked'); }
      if (action === 'status') return { configured: true, available: Boolean(credential), origin };
      if (!credential) fail(404, 'no saved account credential for this origin');
      result = { ...credential, expiresAt: new Date(Date.now() + 120_000).toISOString() };
    }
    // Recheck ownership after asynchronous I/O. Never put secret-bearing input in state.
    this.scope(id, input, identity, action);
    await this.service.store.mutate(state => {
      this.scope(id, input, identity, action);
      state.audit.push({ id: randomUUID(), profileId: identity.profileId, actorId: identity.actorId,
        action: `account.${action}`, subjectId: id, at: new Date().toISOString(), details: { origin } });
    });
    return result;
  }
}
