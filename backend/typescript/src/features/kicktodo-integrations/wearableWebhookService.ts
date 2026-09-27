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
import { createLogger } from '../../observability/logger.js';
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

export class WebhookDeniedError extends Error {} // → uniform 404
export class WebhookUnauthorizedError extends Error {} // → 401

/** Register a provider webhook for a tenant — the RAW token appears once here (give
 *  it to the provider). Requires the provider adapter to be configured (else the
 *  lane is honestly off and there's nothing to receive). */
export async function registerWearableWebhook(tenantId: string, provider: string): Promise<string> {
  if (!wearableProviderConfigured() || !getWearableAdapter(provider)) {
    throw new WebhookDeniedError(`Wearable provider '${provider}' is not configured.`);
  }
  // grade-data 0462-D1 — ROTATE: revoke any prior active token for this
  // (tenant, provider) before minting, so re-registration replaces rather than
  // accumulates un-revocable capabilities (one live webhook token per pair).
  await revokeWearableWebhook(tenantId, provider);
  const { raw } = mintToken('ktwear');
  await registrations.put({ tokenHash: hashToken(raw), tenantId, provider, createdAt: nowIso() });
  return raw;
}

/** Revoke the tenant's active webhook token(s) for a provider — an operator/tenant
 *  action (the token is tenant config, not subject data). Idempotent; bounded
 *  tenant-slice scan (registration is rare, off any hot path). */
export async function revokeWearableWebhook(tenantId: string, provider: string): Promise<void> {
  if (!tenantId || !provider) return;
  for (const r of (await registrations.listForTenantIndexed(tenantId)).filter((x) => x.provider === provider && !x.revokedAt)) {
    await registrations.put({ ...r, revokedAt: nowIso() });
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
}
