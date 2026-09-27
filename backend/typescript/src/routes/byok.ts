/**
 * Host-extension BYOK secret-management routes.
 *
 *   GET    /v1/host/openwop-app/byok/secrets             — list stored refs (NEVER values)
 *   POST   /v1/host/openwop-app/byok/secrets             — { credentialRef, value } → stored
 *   DELETE /v1/host/openwop-app/byok/secrets/:credentialRef
 *
 * Namespace: these routes live under `/v1/host/openwop-app/*` per
 * `spec/v1/host-extensions.md` §"Canonical prefixes" — they are NOT
 * part of the OpenWOP v1 wire contract, so they MUST live under a
 * vendor-prefixed path so a future spec version that defines its own
 * BYOK key-management surface doesn't collide. Adopters replacing the
 * sample with their own host should pick their own prefix
 * (`/v1/host/<your-vendor>/byok/...`).
 *
 * Storage: keys persist to sqlite + AES-256-GCM at rest via
 * `src/byok/encryption.ts`. Real deployers swap for KMS — the route
 * shape stays the same.
 *
 * Auth: every route requires a valid Bearer token (handled by the
 * global auth middleware).
 *
 * WRITES ARE ADMIN-CLASS (ADR 0711). The secret store is TENANT-WIDE: one
 * active-config binding and one key set serve every member of a shared
 * workspace. Before this, the only gate was "signed in", so in a multi-member
 * tenant any co-tenant could rebind the workspace's provider or delete the key
 * everyone's runs resolve through — the same shape the 2026-07 vuln-scan found
 * on the other tenant-scoped management routes. Every MUTATING route below now
 * calls `requireTenantScope(req, 'host:byok:manage')`.
 *
 * Reads stay open to any member: `GET /secrets` lists REFS and never values,
 * and a member who cannot see which provider their own workspace is bound to
 * cannot reason about their own runs.
 *
 * `requireTenantScope` short-circuits for a `user:`/`anon:`-shaped PERSONAL
 * workspace, so the solo-user and anon-demo flows are untouched — the gate bites
 * exactly where ADR 0711 says it should, in tenants with more than one human.
 */

import type { Express } from 'express';
import { OpenwopError } from '../types.js';
import { listSecretRefs, removeSecret, setSecret, type SecretScope } from '../byok/secretResolver.js';
import { lookupCredentialRefConsumers, type ConsumerLookup } from '../host/credentialRefRegistry.js';
import { createLogger } from '../observability/logger.js';
import { requireTenantScope } from '../features/featureRoute.js';
import { appendAudit } from '../host/auditChainService.js';
import { getHeadlessAiDefault, setHeadlessAiDefault, clearHeadlessAiDefault } from '../host/headlessAi.js';
import {
  MANAGED_FREE_REF,
  managedProviderIdFromRef,
  getManagedProviderStatuses,
} from '../providers/managedProvider.js';
import {
  getChatByokConfig, setChatByokConfig, clearChatByokConfig, isChatByokConfigUsable,
} from '../host/chatByokConfig.js';

const log = createLogger('routes.byok');

interface SetSecretRequest {
  credentialRef?: unknown;
  value?: unknown;
}

const REF_PATTERN = /^[a-zA-Z0-9_.\-:]{1,128}$/;

function scopeFromReq(req: import('express').Request): { tenantId: string; actorId?: string } | undefined {
  // In ephemeral mode the resolver needs a tenantId. Pull it from the
  // session-cookie-derived req.tenantId set by the auth middleware.
  // Bearer-authed callers (tenants: ['*']) get no scope, falling back
  // to the SQLite path which is global.
  // Stamp the initiating principal so secret mutations are attributable in
  // the audit log (SEC-4).
  return req.tenantId ? { tenantId: req.tenantId, actorId: req.principal?.principalId } : undefined;
}


/**
 * The managed tier the host would actually dispatch on, or null when it could not.
 *
 * `ready` is the oracle rather than "a target is configured": `getManagedProviderStatuses`
 * returns ready only when a server-held key is seeded AND decryptable, which is precisely
 * the condition under which a managed dispatch gets past `resolveManagedKey`. Advertising
 * an unseeded tier is the silent-degrade failure mode that function exists to expose.
 *
 * The USER-FACING tile ids are reported, never the underlying provider/model: providers.json
 * hides those from the browser on purpose, and for a managed ref dispatch resolves both
 * server-side from the ref (`managedProviderIdFromRef`), so the values below are what the
 * wizard itself sends and never reach a provider call as-is.
 */
async function effectiveManagedDefault(): Promise<{ provider: string; model: string; credentialRef: string } | null> {
  const id = managedProviderIdFromRef(MANAGED_FREE_REF);
  // FAIL SOFT, deliberately. This is the only storage read on a route the SPA mounts on
  // every chat surface, and before option B the null-config branch made none. `resolveManagedKey`
  // memoises on success only, so an UNSEEDED host does a fresh point-read per mount — and a
  // transient DB blip would otherwise propagate to `next(err)` and turn a first-load
  // "connect a provider" screen into a 500. Reporting no default is the honest degradation:
  // it is what the user saw before this feature existed.
  let statuses: Awaited<ReturnType<typeof getManagedProviderStatuses>>;
  try {
    statuses = await getManagedProviderStatuses();
  } catch (err) {
    log.warn('managed_default_probe_failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (!statuses.some((s) => s.providerId === id && s.ready)) return null;
  return { provider: id, model: id, credentialRef: MANAGED_FREE_REF };
}

export function registerByokRoutes(app: Express): void {
  app.get('/v1/host/openwop-app/byok/secrets', async (req, res, next) => {
    try {
      res.json({ credentialRefs: await listSecretRefs(scopeFromReq(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/byok/secrets', async (req, res, next) => {
    try {
      await requireTenantScope(req, 'host:byok:manage');
      const body = req.body as SetSecretRequest;
      if (!body || typeof body !== 'object') {
        throw new OpenwopError('validation_error', 'Request body MUST be a JSON object.', 400);
      }
      if (typeof body.credentialRef !== 'string' || !REF_PATTERN.test(body.credentialRef)) {
        throw new OpenwopError(
          'validation_error',
          'Field `credentialRef` MUST match [a-zA-Z0-9_.-:]{1,128}.',
          400,
          { field: 'credentialRef' },
        );
      }
      if (typeof body.value !== 'string' || body.value.length === 0) {
        throw new OpenwopError(
          'validation_error',
          'Field `value` MUST be a non-empty string.',
          400,
          { field: 'value' },
        );
      }
      await setSecret(body.credentialRef, body.value, scopeFromReq(req));
      // Echo back ONLY the ref + a masked preview. Never the value.
      res.status(201).json({
        credentialRef: body.credentialRef,
        masked: maskInline(body.value),
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/byok/secrets/:credentialRef', async (req, res, next) => {
    try {
      await requireTenantScope(req, 'host:byok:manage');
      const ref = req.params.credentialRef;
      if (!REF_PATTERN.test(ref)) {
        throw new OpenwopError('validation_error', 'Invalid credentialRef.', 400, { credentialRef: ref });
      }
      // ADR 0499 — this route had NO referential check at all. It is the Keys-page
      // delete, and it is the path that actually orphaned a live realtime-voice
      // binding in production: the vault route's guard was never reachable from the
      // UI a user deletes keys with. Same tri-state contract as the vault, so the
      // two delete paths can no longer disagree about what is safe to remove.
      const scope = scopeFromReq(req);
      const force = req.query.force === 'true';
      let lookup: ConsumerLookup;
      try {
        lookup = await lookupCredentialRefConsumers(scope?.tenantId, ref, { hostScoped: scope === undefined });
      } catch (err: unknown) {
        // Log the cause (the ref's NAME is not secret; its value never appears here)
        // so a persistently-broken enumerator is distinguishable from a healthy one
        // that simply refuses.
        log.warn('byok_consumer_lookup_failed', {
          credentialRef: ref,
          error: err instanceof Error ? err.message : String(err),
        });
        lookup = { known: false, reason: 'The reference index could not be computed.' };
      }
      if (!lookup.known && !force) {
        throw new OpenwopError('conflict', `Cannot verify what uses this secret — refusing to delete. ${lookup.reason} Delete with ?force=true to override.`, 409, {
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
      // ADR 0711 option C′ — a `?force=true` delete is audited ON ITS OWN, and
      // deliberately NOT inside either `!force` branch above. Those branches are
      // the paths force SKIPS; recording there would log every override that had
      // nothing to skip and none of the ones that did. The override is the event.
      //
      // It is written BEFORE the delete: an audit that follows the mutation is
      // lost exactly when the mutation is the thing you needed to explain. A
      // failed append therefore fails the request — the alternative is a silent
      // destructive override, which is the shape this option exists to close.
      if (force) {
        await appendAudit(scope?.tenantId ?? 'host-global', 'byok.secret.force_deleted', {
          credentialRef: ref,
          actorId: scope?.actorId ?? null,
          // What the guard WOULD have said, so the record shows what was overridden
          // rather than only that an override happened.
          referencesKnown: lookup.known,
          consumers: lookup.known ? lookup.consumers : null,
          unknownReason: lookup.known ? null : lookup.reason,
          at: new Date().toISOString(),
        });
      }
      await removeSecret(ref, scope);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ── Headless AI default (ADR 0110) — a tenant binding {provider, model, credentialRef}
  // pointing at one of the tenant's own BYOK secrets, used when a headless op (KB media→text)
  // needs a multimodal model the managed provider (MiniMax, text-only) doesn't offer. Lives
  // under /byok/ because it is BYOK config; same session-tenant scope as the secrets above.
  const tenantScope = (req: import('express').Request): SecretScope => {
    const s = scopeFromReq(req);
    if (!s) throw new OpenwopError('unauthenticated', 'Authentication required.', 401);
    return s;
  };

  app.get('/v1/host/openwop-app/byok/ai-default', async (req, res, next) => {
    try {
      res.json({ default: await getHeadlessAiDefault(tenantScope(req).tenantId) });
    } catch (err) { next(err); }
  });

  app.put('/v1/host/openwop-app/byok/ai-default', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { provider?: unknown; model?: unknown; credentialRef?: unknown };
      const saved = await setHeadlessAiDefault(tenantScope(req), body, new Date().toISOString());
      res.status(200).json({ default: saved });
    } catch (err) { next(err); }
  });

  app.delete('/v1/host/openwop-app/byok/ai-default', async (req, res, next) => {
    try {
      await clearHeadlessAiDefault(tenantScope(req).tenantId);
      res.status(204).send();
    } catch (err) { next(err); }
  });

  // ── Active chat binding (ADR 0517) — the tenant's {provider, model, credentialRef}
  // for the AI chat. Previously browser-only localStorage, which is why a workspace
  // that never lost its KEY still lost its POINTER and re-prompted (see
  // host/chatByokConfig.ts for the incident). Same session-tenant scope as the
  // secrets above, so the pointer follows the account, not the browser.

  app.get('/v1/host/openwop-app/byok/active-config', async (req, res, next) => {
    try {
      const scope = tenantScope(req);
      const config = await getChatByokConfig(scope.tenantId);
      // ADR 0711 option B — REPORT the effective default; do not resolve a new one.
      //
      // A managed default already existed at dispatch: `host/exchange/dispatchTurn.ts`
      // and `bootstrap/nodes.ts` both fall through to `managed:openwop-free` when the run
      // carries no credentialRef. What was missing was the REPORT — this route answered
      // `config: null`, and the SPA gates on that and shows "Connect an AI provider",
      // blocking a user before a run that would have dispatched fine.
      //
      // So this is a reporting change and is deliberately confined to this handler.
      // `getChatByokConfig` has exactly ONE backend reader (this route). The dispatch-time
      // answer is proposed by the client through `run.inputs`. Teaching the server to read
      // the binding at dispatch would add a FOURTH owner of "which provider does this
      // workspace use" — a far larger change than reporting what already happens.
      //
      // NO TENANT-SHAPE TEST. The ADR framed this as "multi-principal workspaces", and
      // there are two predicates in this codebase that disagree about the `default`
      // tenant (`isSinglePrincipalTenant` counts it single, `isPersonalTenantId` does
      // not). Keying off either would reintroduce that split. Dispatch consults neither —
      // it defaults unconditionally — so the honest report is the unconditional one.
      const managedDefault = config === null ? await effectiveManagedDefault() : null;
      res.json({
        config: config
          ? { provider: config.provider, model: config.model, credentialRef: config.credentialRef }
          : managedDefault,
        // ADR 0711 OQ1 — an explicit discriminator, never an inference. Without it the SPA
        // cannot tell a binding somebody CHOSE from the tier they fall back to, and
        // `useBYOKConfig`'s heal path would cache the default into localStorage as though
        // the user had picked it.
        stored: config !== null,
        // Authority for "can this binding actually dispatch?" stays server-side. The
        // SPA must never re-derive it from a ref list that a transient failure or a
        // tenant change can empty — that inference is what re-prompted a user whose
        // key was fine.
        // A reported default is only `valid` when the managed key is actually seeded and
        // decryptable. Reporting a tier that would fail at first dispatch would replace one
        // false statement to the user with another.
        valid: config ? await isChatByokConfigUsable(scope, config) : managedDefault !== null,
        // ADR 0517 / fix D — an anonymous session cannot SEE a signed-in workspace's
        // secrets, so "no config" means something completely different here: the user
        // was logged out, not key-less. The SPA branches on this to offer re-auth
        // instead of a first-run wizard that would mint a duplicate key.
        anonymous: scope.tenantId.startsWith('anon:'),
      });
    } catch (err) { next(err); }
  });

  app.put('/v1/host/openwop-app/byok/active-config', async (req, res, next) => {
    try {
      await requireTenantScope(req, 'host:byok:manage');
      const body = (req.body ?? {}) as { provider?: unknown; model?: unknown; credentialRef?: unknown };
      const saved = await setChatByokConfig(tenantScope(req), body, new Date().toISOString());
      res.status(200).json({
        config: { provider: saved.provider, model: saved.model, credentialRef: saved.credentialRef },
        valid: true,
        anonymous: saved.tenantId.startsWith('anon:'),
      });
    } catch (err) { next(err); }
  });

  app.delete('/v1/host/openwop-app/byok/active-config', async (req, res, next) => {
    try {
      await requireTenantScope(req, 'host:byok:manage');
      await clearChatByokConfig(tenantScope(req).tenantId);
      res.status(204).send();
    } catch (err) { next(err); }
  });
}

function maskInline(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
