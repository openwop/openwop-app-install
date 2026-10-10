/**
 * Developer API-key routes (ADR 0270 / CDP-H) under /v1/host/openwop-app/developer-keys.
 * Requires an authenticated principal (issuing a credential is not anonymous) and
 * applies the ADR 0270 self-service/admin key scope. The plaintext token is
 * returned ONCE on issue and never again.
 *
 * § ADR 0434 — the `developer-keys` toggle graduated to always-on, so these
 * management routes no longer 404 on a toggle. The authenticated-principal
 * requirement and `keyScopeOf` remain the real authority.
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { requireString } from '../featureRoute.js';
import { keyMintPolicy, requireMintableScopes, resolveMintExpiry } from './keyPolicy.js';
import { getTenantKeyPolicy, inventoryApiKeys, reportLeakedApiKeys, rotateApiKey, setTenantKeyPolicy } from './apiKeyService.js';
import { DEVELOPER_KEYS_BASE, LEAKED_KEYS_PATH } from './paths.js';
import { invalidateTenantKeyPolicyCache } from './tenantKeyPolicyCache.js';
import { appendAudit } from '../../host/auditChainService.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { isSuperadmin } from '../../host/superadmin.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.developer-keys');
import { assertMayIssueDurableKey, issueApiKey, listApiKeys, revokeApiKey, type KeyScope, type ApiKeyPublic } from './apiKeyService.js';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
/** The app's canonical caller subject (matches resolveEffectiveAccess + featureRoute). */
const callerSubjectOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

async function requirePrincipal(req: Request): Promise<string> {
  const subject = callerSubjectOf(req);
  // An anonymous session HAS a principal (`session:<sid>`, auth.ts), so the
  // presence check alone let an anonymous visitor mint a key (ADR 0771
  // finding). The header's "issuing a credential is not anonymous" is only
  // true with this line.
  const anonymous = (req.principal as { auth?: { kind?: string } } | undefined)?.auth?.kind === 'anon';
  if (!subject || anonymous) throw new OpenwopError('unauthenticated', 'Managing an API key requires an authenticated principal.', 401, {});
  return subject;
}

/**
 * ADR 0800 D1 — an `owk_` key cannot manage keys: not mint, list or revoke.
 *
 * A key is a delegation. MINT took the new key's scopes from the request body,
 * so a key narrowed to `workspace:read` could issue an un-narrowed one (stamped
 * `createdBy: apikey:<id>`, outside the delegating user's own key list). LIST
 * and REVOKE resolved the key's own subject through `keyScopeOf`, and in demo
 * mode `resolveEffectiveAccess` answers OWNER for an unknown subject on a
 * single-principal tenant — so the same read-only key could list and revoke
 * every key in a personal workspace. Keys are managed by a signed-in person, or
 * by the operator's own env credential.
 */
function refuseKeyPrincipal(req: Request): void {
  const kind = (req.principal as { auth?: { kind?: string } } | undefined)?.auth?.kind;
  if (kind === 'api-key') {
    throw new OpenwopError('forbidden', 'An API key cannot manage API keys. Sign in to the app to create or revoke one.', 403, { code: 'key_cannot_manage_keys' });
  }
}

/**
 * The caller's key-management scope (ADR 0270 self-service + admin oversight, /architect-ruled).
 * A self-service caller manages only the keys they created; an admin|owner manages every
 * key in the tenant. The admin check is ADDITIVE — fail-closed roles resolve to own-keys,
 * never a lockout — so a real owner without an explicit accessControl member row keeps
 * self-service access. accessControl is the single owner of the role decision.
 */
async function keyScopeOf(req: Request, callerSubject: string): Promise<KeyScope> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: callerSubject });
  const isAdmin = access.roles.includes('admin') || access.roles.includes('owner');
  return { callerSubject, isAdmin };
}

/**
 * The keys `GET /developer-keys` lists for this caller, with the subject they are
 * judged against — the ONE reader that route and the Access hub summary share
 * (ADR 0864 D2). Throws the route's own 401/403 for an anonymous or `owk_` caller.
 */
export async function listVisibleApiKeys(req: Request): Promise<{ subject: string; keys: ApiKeyPublic[] }> {
  const subject = await requirePrincipal(req);
  refuseKeyPrincipal(req);
  return { subject, keys: await listApiKeys(tenantOf(req), await keyScopeOf(req, subject)) };
}

export function registerDeveloperKeysRoutes({ app }: RouteDeps): void {
  const base = DEVELOPER_KEYS_BASE;

  app.get(base, async (req, res, next) => {
    try {
      // `mine` (ADR 0788, grade-ux MCPUX-5): an admin's list holds every key in the
      // tenant, and without it a person could revoke a colleague's key believing
      // it was their own. Derived from the SAME subject the key was issued under.
      const { subject, keys } = await listVisibleApiKeys(req);
      // `policy` (ADR 0795 D4): what this deployment will issue, so the page
      // offers lifetimes the server will accept instead of guessing.
      const tenantPolicy = await getTenantKeyPolicy(tenantOf(req));
      res.json({
        keys: keys.map((k) => ({ ...k, mine: k.createdBy === subject })),
        policy: { ...keyMintPolicy(tenantPolicy.maxLifetimeDays), disabled: tenantPolicy.disabled === true },
      });
    } catch (err) { next(err); }
  });

  app.post(base, async (req, res, next) => {
    try {
      const subject = await requirePrincipal(req);
      refuseKeyPrincipal(req);
      assertMayIssueDurableKey(subject);
      const b = (req.body ?? {}) as { name?: unknown; scopes?: unknown; expiresAt?: unknown };
      const tenantId = tenantOf(req);
      const tenantPolicy = await getTenantKeyPolicy(tenantId);
      if (tenantPolicy.disabled) throw keysDisabled();
      // ADR 0795 D3 + D4 — explicit, real scopes; a validated, bounded lifetime
      // (ADR 0798: bounded by the workspace's own cap where it set one).
      const scopes = requireMintableScopes(b.scopes);
      const expiresAt = resolveMintExpiry(b.expiresAt, Date.now(), keyMintPolicy(tenantPolicy.maxLifetimeDays));
      const issued = await issueApiKey({
        tenantId,
        name: requireString(b.name, 'name'),
        createdBy: subject, // self-service ownership handle (canonical subject)
        scopes,
        ...(expiresAt ? { expiresAt } : {}),
      });
      await recordKeyEvent(tenantId, 'apikey.created', issued.key, subject);
      void notifyKeyCreated(issued.key);
      // token is returned ONCE — the caller must store it now.
      res.status(201).json(issued);
    } catch (err) { next(err); }
  });

  app.delete(`${base}/:id`, async (req, res, next) => {
    try {
      const subject = await requirePrincipal(req);
      refuseKeyPrincipal(req);
      // Out-of-scope key (not yours + not admin, or wrong tenant) ⇒ false ⇒ 404, no existence leak.
      if (!(await revokeApiKey(tenantOf(req), req.params.id, await keyScopeOf(req, subject)))) {
        throw new OpenwopError('not_found', 'Key not found.', 404, { keyId: req.params.id });
      }
      await recordKeyEvent(tenantOf(req), 'apikey.revoked', { keyId: req.params.id }, subject);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ADR 0798 — rotate: a replacement with the same scopes, and a bounded overlap
  // on the old key. The new token is returned ONCE.
  app.post(`${base}/:id/rotate`, async (req, res, next) => {
    try {
      const subject = await requirePrincipal(req);
      refuseKeyPrincipal(req);
      // ADR 0833 D2 — rotation hands the CALLER a fresh plaintext for a key
      // whose `createdBy` is the original owner, so the mint-time refusal in
      // `issueApiKey` never sees the break-glass session. Refused here.
      assertMayIssueDurableKey(subject);
      const tenantId = tenantOf(req);
      const tenantPolicy = await getTenantKeyPolicy(tenantId);
      if (tenantPolicy.disabled) throw keysDisabled();
      const b = (req.body ?? {}) as { expiresAt?: unknown };
      const expiresAt = resolveMintExpiry(b.expiresAt, Date.now(), keyMintPolicy(tenantPolicy.maxLifetimeDays));
      const rotated = await rotateApiKey(tenantId, req.params.id, await keyScopeOf(req, subject), {
        rotatedBy: subject,
        ...(expiresAt ? { expiresAt } : {}),
      });
      // Out-of-scope key ⇒ 404, no existence leak (the revoke route's shape).
      if (!rotated) throw new OpenwopError('not_found', 'Key not found.', 404, { keyId: req.params.id });
      await recordKeyEvent(tenantId, 'apikey.rotated', rotated.key, subject, { rotatedFrom: rotated.previous.keyId, previousExpiresAt: rotated.previous.expiresAt });
      res.status(201).json(rotated);
    } catch (err) { next(err); }
  });

  // ADR 0798 — the workspace's own rules about keys. Read by anyone who may
  // manage a key here; changed only by an admin or owner.
  app.get(`${base}/policy`, async (req, res, next) => {
    try {
      await requirePrincipal(req);
      refuseKeyPrincipal(req);
      const tenantPolicy = await getTenantKeyPolicy(tenantOf(req));
      res.json({ policy: tenantPolicy, effective: { ...keyMintPolicy(tenantPolicy.maxLifetimeDays), disabled: tenantPolicy.disabled === true } });
    } catch (err) { next(err); }
  });

  app.put(`${base}/policy`, async (req, res, next) => {
    try {
      const subject = await requirePrincipal(req);
      refuseKeyPrincipal(req);
      if (!(await keyScopeOf(req, subject)).isAdmin) {
        throw new OpenwopError('forbidden', 'Only a workspace admin or owner can change the API key policy.', 403, { code: 'admin_required' });
      }
      const b = (req.body ?? {}) as { disabled?: unknown; maxLifetimeDays?: unknown };
      if (b.disabled !== undefined && typeof b.disabled !== 'boolean') {
        throw new OpenwopError('validation_error', 'disabled must be a boolean.', 400, { field: 'disabled' });
      }
      const max = b.maxLifetimeDays;
      if (max !== undefined && max !== null && !(typeof max === 'number' && Number.isInteger(max) && max >= 1 && max <= 3660)) {
        throw new OpenwopError('validation_error', 'maxLifetimeDays must be a whole number of days from 1 to 3660, or null to clear it.', 400, { field: 'maxLifetimeDays' });
      }
      const tenantId = tenantOf(req);
      const next_ = await setTenantKeyPolicy(tenantId, {
        ...(typeof b.disabled === 'boolean' ? { disabled: b.disabled } : {}),
        ...(max !== undefined ? { maxLifetimeDays: max as number | null } : {}),
      }, subject);
      await appendAudit(tenantId, 'apikey.policy-changed', { actor: subject, disabled: next_.disabled === true, maxLifetimeDays: next_.maxLifetimeDays ?? null });
      invalidateTenantKeyPolicyCache(tenantId);
      res.json({ policy: next_, effective: { ...keyMintPolicy(next_.maxLifetimeDays), disabled: next_.disabled === true } });
    } catch (err) { next(err); }
  });

  // ADR 0798 D8 (`KEY-9`) — a key found in public is revoked by whoever found
  // it. UNAUTHENTICATED (it is on the public-path list): the full secret is the
  // credential, as with any capability-token route. Accepts the shape secret-
  // scanning partners POST (`[{ token, type, url, source }]`) or `{ tokens }`.
  app.post(LEAKED_KEYS_PATH, async (req, res, next) => {
    try {
      const body: unknown = req.body;
      const entries: Array<{ token: string; source?: string }> = [];
      const list = Array.isArray(body) ? body : Array.isArray((body as { tokens?: unknown } | null)?.tokens) ? (body as { tokens: unknown[] }).tokens : null;
      if (!list || list.length === 0 || list.length > 100) {
        throw new OpenwopError('validation_error', 'Send 1 to 100 tokens: an array of { token }, or { tokens: [...] }.', 400, {});
      }
      for (const item of list) {
        const token = typeof item === 'string' ? item : (item as { token?: unknown } | null)?.token;
        if (typeof token !== 'string' || token.length > 200) {
          throw new OpenwopError('validation_error', 'Each entry needs a token string.', 400, {});
        }
        const src = typeof item === 'object' && item !== null ? (item as { url?: unknown; source?: unknown }) : {};
        const source = typeof src.url === 'string' ? src.url : typeof src.source === 'string' ? src.source : undefined;
        entries.push({ token, ...(source ? { source } : {}) });
      }
      const out: Array<{ token_raw: string; token_type: string; label: 'true_positive' | 'false_positive' }> = [];
      for (const e of entries) {
        const [r] = await reportLeakedApiKeys([e.token], e.source);
        out.push({ token_raw: e.token, token_type: 'openwop_api_key', label: r!.known ? 'true_positive' : 'false_positive' });
      }
      res.status(200).json(out);
    } catch (err) { next(err); }
  });

  // ADR 0798 (`KEY-11`) — every key on the host, by shape. Superadmin only.
  app.get(`${base}/inventory`, async (req, res, next) => {
    try {
      await requirePrincipal(req);
      refuseKeyPrincipal(req);
      if (!isSuperadmin(req)) throw new OpenwopError('forbidden', 'The key inventory is a host-wide read; it needs a superadmin.', 403, { code: 'superadmin_required' });
      res.json(await inventoryApiKeys());
    } catch (err) { next(err); }
  });
}

function keysDisabled(): OpenwopError {
  return new OpenwopError('forbidden', 'API keys are turned off for this workspace. A workspace admin can turn them back on.', 403, { code: 'keys_disabled' });
}

/**
 * ADR 0798 (`KEY-7`) — a key's life is on the tenant's audit chain: who created,
 * rotated or revoked what, with which scopes. Ids and scopes only; the key's
 * NAME is a person's free text and the chain is append-only.
 */
async function recordKeyEvent(
  tenantId: string,
  kind: 'apikey.created' | 'apikey.rotated' | 'apikey.revoked',
  key: { keyId: string; scopes?: string[]; expiresAt?: string },
  actor: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await appendAudit(tenantId, kind, {
      keyId: key.keyId,
      actor,
      ...(key.scopes ? { scopes: key.scopes } : {}),
      ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
      ...extra,
    });
  } catch (err) {
    // The audit chain is a record, not a gate: the key exists either way, and
    // refusing to say so would hide it rather than prevent it.
    log.error('api key audit append failed', { tenantId, kind, keyId: key.keyId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Tell the owner a key now exists in their name. Inbox is keyed by user id. */
async function notifyKeyCreated(key: { keyId: string; name: string; tenantId: string; createdBy: string; hint?: string }): Promise<void> {
  if (!key.createdBy.startsWith('user:')) return;
  try {
    await getNotificationEmitter().emit({
      notificationId: `apikey-created-${key.keyId.replace(/[^a-zA-Z0-9]/g, '-')}`,
      tenantId: key.tenantId,
      recipientUserId: key.createdBy,
      type: 'apikey.created',
      priority: 'normal',
      title: `API key “${key.name}” was created`,
      message: `A key${key.hint ? ` (${key.hint})` : ''} now acts as you in this workspace. If you did not create it, revoke it.`,
      actionUrl: '/access?tab=api-keys',
    });
  } catch {
    // A courtesy, never a dependency: the key is listed on the tab regardless.
  }
}
