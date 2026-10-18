/**
 * ADR 0462 Phase 2 — the wearable provider WEBHOOK ingress.
 *
 * A public webhook cannot trust a request-claimed tenant, so — mirroring the feed
 * token — a per-(tenant,provider) HASHED webhook token in the URL resolves
 * `{tenant, provider}` (uniform 404 on unknown). The `providerUserId` then comes from
 * the VERIFIED push, and the subject from the link store. The push terminates in the
 * EXISTING `ingestWearableMetric` kernel — never a second ingest path.
 *
 * Fail-closed pipeline (order is load-bearing):
 *   token → toggle kill-switch → verify signature FIRST (adapter, secret from the
 *   tenant's Connection) → resolve provider account → live `wearable-evidence`
 *   consent → normalize → ingest. An unverified push is 401; an unknown token 404;
 *   an unknown provider account / no consent / no reading is a silent 204 (no work,
 *   no existence leak). Idempotent via the kernel's occurrence→check-in.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { createLogger } from '../../observability/logger.js';
import { KICKTODO_REVOKED_ROW_RETENTION_DAYS } from '../kicktodo-core/types.js';
import { hashToken, mintToken } from '../../host/capabilityToken.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { resolveConnectionCredential } from '../connections/connectionsService.js';
import { getWearableAdapter, wearableProviderConfigured, type WearablePush } from './wearableProviderAdapter.js';
import { resolveSubjectForProviderUser } from './wearableLinkService.js';
import { ingestWearableMetric, ConsentRequiredError } from './integrationService.js';

const log = createLogger('kicktodo.wearableWebhook');
const nowIso = (): string => new Date().toISOString();

interface WebhookReg {
  tokenHash: string; // the ONLY stored form of the token
  tenantId: string;
  provider: string;
  createdAt: string;
  revokedAt?: string;
}

/** Keyed by token HASH (global — the public route has no tenant). */
const registrations = new DurableCollection<WebhookReg>(
  'kicktodo-wearable-webhook',
  (r) => r.tokenHash,
  undefined,
  (r) => r.tenantId, // tenant-index → bounded revocation (grade-data 0462-D1)
);

/**
 * KTINT-4 (KickTodo wave 4C) — the ONE-live-token CLAIM per (tenant, provider):
 * the current token's hash, taken by CAS. Rotation used to be revoke-then-put, so
 * two concurrent registrations each revoked nothing and each put a live token —
 * two live capabilities for one pair, the second never revocable by a re-register
 * that only knew of one. Same shape as the invite one-live index (KTCORE-3).
 * Content-free (tenant + provider + hash).
 */
const currentToken = new DurableCollection<{ tenantId: string; provider: string; tokenHash: string }>(
  'kicktodo-wearable-webhook-current',
  (r) => `${r.tenantId}::${r.provider}`,
);

// KTINT-4 — revoked webhook tokens were never purged (one per rotation). A revoked
// token already 404s exactly like an unknown one; past the window it is reclaimed
// through the (tenant-indexed) collection, so its index marker goes with it.
registerKvAgeOut({
  id: 'kicktodo-wearable-webhook:revoked',
  prefix: 'hostext:kicktodo-wearable-webhook:',
  ttlDays: KICKTODO_REVOKED_ROW_RETENTION_DAYS,
  timestampField: 'revokedAt',
  acceptIndexed: true,
});

export class WebhookConflictError extends Error {
  constructor() { super('Concurrent webhook registrations — retry.'); }
}

export class WebhookDeniedError extends Error {} // → uniform 404
export class WebhookUnauthorizedError extends Error {} // → 401

/** Register a provider webhook for a tenant — the RAW token appears once here (give
 *  it to the provider). Requires the provider adapter to be configured (else the
 *  lane is honestly off and there's nothing to receive). */
export async function registerWearableWebhook(tenantId: string, provider: string): Promise<string> {
  if (!wearableProviderConfigured() || !getWearableAdapter(provider)) {
    throw new WebhookDeniedError(`Wearable provider '${provider}' is not configured.`);
  }
  // grade-data 0462-D1 — ROTATE: re-registration replaces rather than accumulates
  // un-revocable capabilities (one live webhook token per pair).
  //
  // KTINT-4 — atomically: claim the pair's CURRENT pointer by CAS first, write
  // the token row only AFTER winning, then revoke every live token for the pair
  // that the pointer does not name (the previous one, any minted before the
  // pointer existed, and ours if a later registration already superseded us).
  // The pointer only ever moves to a hash whose row is written after the move,
  // so a token the pointer has left is never current again: re-reading it per
  // row makes every interleaving end with exactly the pointer's token live.
  const key = `${tenantId}::${provider}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const prior = await currentToken.get(key);
    const { raw, hash } = mintToken('ktwear');
    if (!(await currentToken.compareAndSwap(prior, { tenantId, provider, tokenHash: hash }))) continue;
    await registrations.put({ tokenHash: hash, tenantId, provider, createdAt: nowIso() });
    await revokeSupersededTokens(tenantId, provider);
    return raw;
  }
  throw new WebhookConflictError();
}

/** Revoke the pair's live tokens other than the one the CURRENT pointer names,
 *  re-reading the pointer before each revoke. Bounded tenant-slice read. */
async function revokeSupersededTokens(tenantId: string, provider: string): Promise<void> {
  const key = `${tenantId}::${provider}`;
  for (const r of await registrations.listForTenantIndexed(tenantId)) {
    if (r.provider !== provider || r.revokedAt) continue;
    if ((await currentToken.get(key))?.tokenHash === r.tokenHash) continue;
    await revokeRow(r);
  }
}

/** CAS revoke of one token row (a concurrent revoke of the same row converges). */
async function revokeRow(r: WebhookReg): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const cur = attempt === 0 ? r : await registrations.get(r.tokenHash);
    if (!cur || cur.revokedAt) return;
    if (await registrations.compareAndSwap(cur, { ...cur, revokedAt: nowIso() })) return;
  }
}

/** Revoke the tenant's active webhook token(s) for a provider — an operator/tenant
 *  action (the token is tenant config, not subject data). Idempotent; bounded
 *  tenant-slice scan (registration is rare, off any hot path). */
export async function revokeWearableWebhook(tenantId: string, provider: string): Promise<void> {
  if (!tenantId || !provider) return;
  for (const r of (await registrations.listForTenantIndexed(tenantId)).filter((x) => x.provider === provider && !x.revokedAt)) {
    await revokeRow(r);
  }
}

/** Ingest a provider push. Returns the number of readings ingested (0 is a valid,
 *  silent outcome). Throws WebhookUnauthorizedError (401) / WebhookDeniedError (404). */
export async function ingestWearableWebhook(rawToken: string, push: WearablePush): Promise<{ ingested: number }> {
  const reg = await registrations.get(hashToken(rawToken));
  if (!reg || reg.revokedAt) throw new WebhookDeniedError('unknown token');
  // Operator kill-switch: a tenant whose toggle is OFF receives nothing.
  const assignment = await resolveOne('kicktodo-integrations', { tenantId: reg.tenantId });
  if (!assignment || !assignment.enabled) throw new WebhookDeniedError('feature off');

  const adapter = getWearableAdapter(reg.provider);
  if (!adapter || !wearableProviderConfigured()) throw new WebhookDeniedError('provider not configured');

  // Verify FIRST — the signing secret comes from the tenant's Connection, never a row.
  const cred = await resolveConnectionCredential({ tenantId: reg.tenantId, provider: reg.provider }).catch(() => null);
  if (!cred?.secret || !adapter.verify(cred.secret, push)) {
    throw new WebhookUnauthorizedError('signature'); // no detail echo
  }

  const providerUserId = adapter.extractProviderUserId(push.payload);
  if (!providerUserId) return { ingested: 0 }; // nothing addressable — silent
  const subject = await resolveSubjectForProviderUser(reg.tenantId, reg.provider, providerUserId);
  if (!subject) return { ingested: 0 }; // unknown/unlinked account — no leak, no work

  let ingested = 0;
  for (const { metric, value } of adapter.normalize(push.payload)) {
    try {
      // ingestWearableMetric re-checks the subject's live wearable-evidence consent
      // (revoked ⇒ ConsentRequiredError, swallowed to a silent drop) and is idempotent.
      ingested += await ingestWearableMetric(reg.tenantId, subject, metric, value);
    } catch (err) {
      if (err instanceof ConsentRequiredError) { log.info('kicktodo_wearable_webhook_no_consent', { provider: reg.provider }); return { ingested }; }
      throw err;
    }
  }
  return { ingested };
}

/** Test-only reset. */
export async function __resetWearableWebhooks(): Promise<void> {
  await registrations.__clear();
  await currentToken.__clear();
}

/** Test seam. */
export const __test = { registrations, currentToken };
