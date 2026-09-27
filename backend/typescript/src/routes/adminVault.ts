/**
 * Secrets-vault admin surface (ADR 0389 Phase 2) — a superadmin PROJECTION +
 * management layer over the existing credential owners. It stores nothing of
 * its own: raw tenant/host secrets stay in `byok/secretResolver`, OAuth
 * connections in `connectionsService`, host OAuth clients in
 * `oauthClientStore`, developer keys in `apiKeyService`. Audit rows ride the
 * EXISTING tamper-evident hash chain (`host/auditChainService`,
 * `security.*` kinds) — deliberately NOT a new audit collection (ADR 0389
 * §Implementation correction: a second audit store would duplicate the owner).
 *
 *   GET    /v1/host/openwop-app/vault
 *   POST   /v1/host/openwop-app/vault/secrets                          add (masked thereafter)
 *   POST   /v1/host/openwop-app/vault/secrets/:credentialRef/reveal    step-up + audit, once
 *   POST   /v1/host/openwop-app/vault/secrets/:credentialRef/rotate    overwrite + audit
 *   DELETE /v1/host/openwop-app/vault/secrets/:credentialRef           dependency check + audit
 *
 * Invariants (review these before touching anything here):
 *  - The LIST boundary never carries a secret value — refs/status/metadata only.
 *  - Reveal is offered ONLY for operator-entered raw secrets. `connection:*`
 *    refs hold delegated OAuth token JSON (ADR 0024 keeps them off every read
 *    boundary) and are REFUSED; hashed developer keys have nothing to reveal.
 *  - Reveal demands STEP-UP: a bearer whose `auth_time` is fresh
 *    (OPENWOP_VAULT_REVEAL_MAX_AUTH_AGE_S, default 300s). Cookie-only callers
 *    fail closed (no `auth_time` to trust). The audit row is written BEFORE
 *    the value is returned — a crashed response still leaves the trace.
 *  - Delete fails CLOSED on live references: a ref consumed by the tenant's
 *    headless-AI default (or any `connection:*` ref, whose lifecycle belongs
 *    to the connection) is refused with the consumers named; `?force=true`
 *    overrides for plain refs only, and still audits.
 *  - Scope: the vault inventories the superadmin's ACTIVE tenant + host-global
 *    refs. Cross-tenant enumeration is deliberately OUT (the 2026-07 vuln-scan
 *    M3 posture restricts ref-name visibility per tenant; widening it needs a
 *    storage-interface change and its own decision — recorded in ADR 0389).
 */

import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import { requireSuperadmin } from '../host/superadmin.js';
import {
  listSecretRefs,
  resolveSecret,
  setSecret,
  removeSecret,
  type SecretScope,
} from '../byok/secretResolver.js';
import { listConnections } from '../features/connections/connectionsService.js';
import { listHostOAuthClients } from '../features/connections/oauthClientStore.js';
import { listApiKeys } from '../features/developer-keys/apiKeyService.js';
import { lookupCredentialRefConsumers, type ConsumerLookup } from '../host/credentialRefRegistry.js';
import { appendAudit } from '../host/auditChainService.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.adminVault');

const REF_PATTERN = /^[a-zA-Z0-9_.\-:]{1,128}$/;

/** Step-up freshness window for reveal (seconds). */
function revealMaxAuthAgeS(): number {
  const raw = Number(process.env.OPENWOP_VAULT_REVEAL_MAX_AUTH_AGE_S);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

function actorOf(req: Request): string {
  return req.principal?.principalId ?? 'unknown';
}

/** The per-tenant audit chain to write under. The wildcard admin bearer has no
 *  tenant — its operator actions chain under the reserved `host-admin` tenant
 *  so they stay tamper-evident and greppable in one place. */
function auditTenant(req: Request): string {
  return req.tenantId ?? 'host-admin';
}

/** Tenant vs host-global scope for a secret operation (query/body `scope`). */
function secretScope(req: Request, raw: unknown): SecretScope | undefined {
  if (raw === 'host') return undefined; // un-scoped ⇒ the host-global bucket
  const t = req.tenantId;
  if (!t) {
    // The wildcard admin bearer carries no tenant — it manages the HOST bucket.
    throw new OpenwopError('validation_error', 'Tenant-scoped secret operations need a tenant session; pass scope:"host" for the host-global bucket.', 400, { field: 'scope' });
  }
  return { tenantId: t, actorId: actorOf(req) };
}

function validRef(ref: unknown): string {
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) {
    throw new OpenwopError('validation_error', 'Field `credentialRef` MUST match [a-zA-Z0-9_.-:]{1,128}.', 400, {
      field: 'credentialRef',
    });
  }
  return ref;
}

/** Delegated-credential refs (OAuth token JSON) — never revealed/rotated raw. */
const isConnectionRef = (ref: string): boolean => ref.startsWith('connection:');

export function registerAdminVaultRoutes(app: Express): void {
  // ── Inventory (masked — refs/status/metadata, NEVER values) ──
  app.get('/v1/host/openwop-app/vault', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'The secrets vault');
      const tenantId = req.tenantId; // absent for the wildcard admin bearer
      const [tenantRefs, hostRefs, connections, oauthClients, apiKeys] = await Promise.all([
        tenantId ? listSecretRefs({ tenantId }) : Promise.resolve([] as readonly string[]),
        listSecretRefs(),
        tenantId ? listConnections(tenantId) : Promise.resolve([]),
        listHostOAuthClients(),
        tenantId ? listApiKeys(tenantId, { callerSubject: actorOf(req), isAdmin: true }) : Promise.resolve([]),
      ]);
      res.json({
        tenantSecrets: tenantRefs.map((ref) => ({
          credentialRef: ref,
          kind: isConnectionRef(ref) ? 'connection-token' : 'raw',
          revealable: !isConnectionRef(ref),
        })),
        hostSecrets: hostRefs.map((ref) => ({ credentialRef: ref, kind: 'raw', revealable: true })),
        connections: connections.map((c) => ({
          connectionId: c.connectionId,
          provider: c.provider,
          kind: c.kind,
          status: c.status,
          scopes: c.scopes,
          displayName: c.displayName,
          expiresAt: c.expiresAt,
        })),
        oauthClients,
        apiKeys,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Add (shown once at creation by the CLIENT; server stores + masks) ──
  app.post('/v1/host/openwop-app/vault/secrets', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'The secrets vault');
      const body = (req.body ?? {}) as { credentialRef?: unknown; value?: unknown; scope?: unknown };
      const ref = validRef(body.credentialRef);
      if (typeof body.value !== 'string' || body.value.length === 0) {
        throw new OpenwopError('validation_error', 'Field `value` MUST be a non-empty string.', 400, { field: 'value' });
      }
      if (isConnectionRef(ref)) {
        throw new OpenwopError('validation_error', '`connection:*` refs are owned by the connections lifecycle — create a connection instead.', 400, { credentialRef: ref });
      }
      const scope = secretScope(req, body.scope);
      // GRADE-PASS DATAG-2: audit BEFORE the mutation (the reveal-route
      // posture) — a failed append must abort, never yield an unaudited write.
      await appendAudit(auditTenant(req), 'security.secret-set', {
        credentialRef: ref,
        scope: scope ? 'tenant' : 'host',
        actor: actorOf(req),
      });
      // …and a COMPENSATING record if the write then fails.
      //
      // Keeping the pre-write append is right (DATAG-2 above): an audit failure
      // must abort rather than yield an unaudited write. But the ordering has a
      // cost the comment doesn't name — when `setSecret` throws, the chain is left
      // asserting a `security.secret-set` that never happened. Ephemeral mode makes
      // that reachable for every host-scope write (`setSecret` throws on a
      // scopeless ref), so the phantom is not hypothetical.
      //
      // Auditing AFTER instead would trade an over-report for an UNDER-report — a
      // crash between write and append would hide a real secret change, which is
      // strictly worse. So: keep the intent record, add the outcome record. An
      // auditor reading the chain sees the attempt AND that it did not land.
      try {
        await setSecret(ref, body.value, scope);
      } catch (err) {
        await appendAudit(auditTenant(req), 'security.secret-set-failed', {
          credentialRef: ref,
          scope: scope ? 'tenant' : 'host',
          actor: actorOf(req),
          // Message only — never the value being stored.
          error: err instanceof Error ? err.message : String(err),
        }).catch(() => undefined); // a failed compensation must not mask the real error
        throw err;
      }
      res.status(201).json({ credentialRef: ref, stored: true });
    } catch (err) {
      next(err);
    }
  });

  // ── Reveal-once (step-up + audit-before-return) ──
  app.post('/v1/host/openwop-app/vault/secrets/:credentialRef/reveal', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'The secrets vault');
      const ref = validRef(req.params.credentialRef);
      if (isConnectionRef(ref)) {
        throw new OpenwopError('forbidden', 'Delegated OAuth credentials are never revealed (ADR 0024). Re-consent to rotate them.', 403, { credentialRef: ref });
      }
      // STEP-UP: a fresh re-authentication, proven by the bearer's auth_time.
      // The wildcard admin bearer is EXEMPT — possession of the operator API
      // key IS the step-up (there is no Firebase session to re-verify), and
      // it's the same principal `requireSuperadmin` already trusts outright.
      const isWildcardAdmin = req.principal?.tenants?.includes('*') === true;
      const maxAge = revealMaxAuthAgeS();
      const authTime = req.oidcAuthTime;
      const nowS = Math.floor(Date.now() / 1000);
      if (!isWildcardAdmin && (typeof authTime !== 'number' || nowS - authTime > maxAge)) {
        throw new OpenwopError('forbidden', `Revealing a secret requires a sign-in fresher than ${maxAge}s. Re-authenticate and retry with the fresh bearer token.`, 403, {
          reason: 'stepup_required',
          maxAuthAgeS: maxAge,
        });
      }
      const body = (req.body ?? {}) as { scope?: unknown };
      const scope = secretScope(req, body.scope);
      const value = await resolveSecret(ref, scope);
      if (value === null) {
        throw new OpenwopError('not_found', 'No secret stored under that credentialRef.', 404, { credentialRef: ref });
      }
      // Audit BEFORE the value crosses the boundary — a lost response must
      // still leave the trace.
      await appendAudit(auditTenant(req), 'security.secret-reveal', {
        credentialRef: ref,
        scope: scope ? 'tenant' : 'host',
        actor: actorOf(req),
      });
      log.warn('vault_secret_revealed', { credentialRef: ref, actor: actorOf(req), tenantId: auditTenant(req) });
      res.json({ credentialRef: ref, value });
    } catch (err) {
      next(err);
    }
  });

  // ── Rotate (overwrite raw refs; connections rotate via re-consent) ──
  app.post('/v1/host/openwop-app/vault/secrets/:credentialRef/rotate', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'The secrets vault');
      const ref = validRef(req.params.credentialRef);
      if (isConnectionRef(ref)) {
        throw new OpenwopError('validation_error', 'Rotate a connection via its re-consent/refresh flow, not a raw overwrite (ADR 0024).', 400, { credentialRef: ref });
      }
      const body = (req.body ?? {}) as { value?: unknown; scope?: unknown };
      if (typeof body.value !== 'string' || body.value.length === 0) {
        throw new OpenwopError('validation_error', 'Field `value` MUST be a non-empty string.', 400, { field: 'value' });
      }
      const scope = secretScope(req, body.scope);
      const existing = await resolveSecret(ref, scope);
      if (existing === null) {
        throw new OpenwopError('not_found', 'No secret stored under that credentialRef — use add, not rotate.', 404, { credentialRef: ref });
      }
      // GRADE-PASS DATAG-2: audit-before-mutate, fail-closed.
      await appendAudit(auditTenant(req), 'security.secret-rotate', {
        credentialRef: ref,
        scope: scope ? 'tenant' : 'host',
        actor: actorOf(req),
      });
      await setSecret(ref, body.value, scope);
      res.json({ credentialRef: ref, rotated: true });
    } catch (err) {
      next(err);
    }
  });

  // ── Delete (dependency check, fail-closed) ──
  app.delete('/v1/host/openwop-app/vault/secrets/:credentialRef', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'The secrets vault');
      const ref = validRef(req.params.credentialRef);
      if (isConnectionRef(ref)) {
        throw new OpenwopError('validation_error', 'A `connection:*` secret is deleted by deleting its connection (the owning lifecycle cascades it).', 400, { credentialRef: ref });
      }
      const scope = secretScope(req, req.query.scope);
      const force = req.query.force === 'true';
      // FAIL-CLOSED (ENG-2 / SEC-G4). Three distinct answers, and only the
      // first one permits an unforced delete:
      //   known + empty  -> we looked within the tenant, nothing binds it
      //   known + refs   -> named live bindings, 409 unless forced
      //   NOT known      -> we could not look, 409 unless forced
      // The `not known` arm previously did not exist: a scopeless/host secret
      // and the wildcard admin bearer (no `req.tenantId`) both yielded `[]`,
      // which reads as "nothing uses this". That is the permissive answer to
      // an unanswered question, on the most privileged path in the route.
      let lookup: ConsumerLookup;
      try {
        lookup = await lookupCredentialRefConsumers(req.tenantId, ref, { hostScoped: scope === undefined });
      } catch (err) {
        // GRADE-DELTA CODE-1 — the tri-state swallowed this silently. An operator
        // saw "cannot verify what uses this secret" with no way to learn WHY, and
        // nothing reached the logs, so a persistently-broken enumerator would look
        // identical to a healthy one that simply refuses. Log the cause (never the
        // ref's VALUE — only its name, which is not secret) and keep failing closed.
        log.warn('vault_consumer_lookup_failed', {
          credentialRef: ref,
          actor: actorOf(req),
          tenantId: auditTenant(req),
          error: err instanceof Error ? err.message : String(err),
        });
        lookup = { known: false, reason: 'The reference index could not be computed.' };
      }
      if (!lookup.known && !force) {
        throw new OpenwopError('conflict', `Cannot verify what uses this secret — refusing to delete. ${lookup.reason} Delete with ?force=true to override, or resolve consumers manually.`, 409, {
          credentialRef: ref,
          referencesKnown: false,
        });
      }
      if (lookup.known && lookup.consumers.length > 0 && !force) {
        throw new OpenwopError('conflict', 'This secret has live references. Delete with ?force=true to override.', 409, {
          credentialRef: ref,
          references: lookup.consumers,
        });
      }
      const consumers = lookup.known ? lookup.consumers : [];
      // GRADE-PASS DATAG-2: audit-before-mutate, fail-closed.
      await appendAudit(auditTenant(req), 'security.secret-delete', {
        credentialRef: ref,
        scope: scope ? 'tenant' : 'host',
        actor: actorOf(req),
        forced: force,
        // Record WHICH answer we had. A forced delete over an unknown index is
        // a materially different act from a forced delete over a named binding,
        // and the audit trail is the only place that distinction survives.
        referencesKnown: lookup.known,
        references: consumers,
        ...(lookup.known ? {} : { referencesUnknownReason: lookup.reason }),
      });
      await removeSecret(ref, scope);
      res.json({ credentialRef: ref, deleted: true });
    } catch (err) {
      next(err);
    }
  });
}
