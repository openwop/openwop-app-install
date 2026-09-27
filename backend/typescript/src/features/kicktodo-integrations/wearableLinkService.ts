/**
 * ADR 0462 Phase 1 — the wearable provider→subject LINK store.
 *
 * A provider webhook (Phase 2) identifies the user by the PROVIDER's own account id
 * (e.g. a Fitbit user id), not our opaque subject. This store is the ONLY place the
 * two identities are bound, and it can only be written when the SUBJECT is present —
 * i.e. when the participant links their device under their own session. The webhook
 * then resolves `(provider, providerUserId) → ownerSubject` to reach the existing
 * `ingestWearableMetric` kernel.
 *
 * Privacy (ADR 0426): the row carries the OPAQUE `ownerSubject` + the provider's own
 * account id only — never name/email/PII. Purge-safe (tenant-in-content + `tenantOf`).
 * Erasure (ADR 0381): a subject's links are dropped with them (see
 * `eraseWearableLinksForSubject`, wired into `integrationService.eraseIntegrationsSubject`).
 *
 * Binding rule: FIRST-WRITE-WINS per `(tenantId, provider, providerUserId)` — one
 * provider account maps to exactly one subject, so a second participant cannot claim
 * (hijack) another's provider account's data. A participant re-links by `unlink` first.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { liveConsent, ConsentRequiredError } from './integrationService.js';

const log = createLogger('kicktodo.wearableLink');
const nowIso = (): string => new Date().toISOString();

export interface WearableLink {
  tenantId: string;
  /** The RFC 0095 provider id (e.g. `fitbit`). */
  provider: string;
  /** The provider's OWN account id for this user — opaque to us, not our subject. */
  providerUserId: string;
  /** The opaque KickTodo subject (ADR 0426) this provider account belongs to. */
  ownerSubject: string;
  linkedAt: string;
}

const links = new DurableCollection<WearableLink>(
  'kicktodo-wearable-link',
  (l) => `${l.tenantId}::${l.provider}::${l.providerUserId}`,
  undefined,
  (l) => l.tenantId, // KTD-1 purge-safe
);

/** Bind a provider account to the acting subject. Fail-closed: requires a live
 *  `wearable-evidence` consent (linking a device IS opting that data in). Idempotent
 *  first-write-wins — a conflicting claim by a DIFFERENT subject keeps the first
 *  binding and logs (never silently re-points a provider account to a new subject). */
export async function linkWearableProvider(
  tenantId: string,
  ownerSubject: string,
  provider: string,
  providerUserId: string,
): Promise<WearableLink> {
  if (!(await liveConsent(tenantId, ownerSubject, 'wearable-evidence'))) {
    throw new ConsentRequiredError('wearable-evidence');
  }
  const key = `${tenantId}::${provider}::${providerUserId}`;
  const existing = await links.get(key);
  if (existing) {
    if (existing.ownerSubject !== ownerSubject) {
      log.warn('kicktodo_wearable_link_conflict', { provider, existing: existing.ownerSubject, attempted: ownerSubject });
    }
    return existing;
  }
  const link: WearableLink = { tenantId, provider, providerUserId, ownerSubject, linkedAt: nowIso() };
  await links.put(link);
  log.info('kicktodo_wearable_linked', { provider });
  return link;
}

/** The subject a provider account is bound to, or null. The Phase-2 webhook's
 *  identity resolution (tenant-scoped point read; no cross-tenant scan). */
export async function resolveSubjectForProviderUser(
  tenantId: string,
  provider: string,
  providerUserId: string,
): Promise<string | null> {
  if (!tenantId || !provider || !providerUserId) return null;
  const link = await links.get(`${tenantId}::${provider}::${providerUserId}`);
  return link ? link.ownerSubject : null;
}

/** Unlink a provider account — but ONLY the acting subject's own binding
 *  (ownership-checked, so one subject can't unlink another's). No-op otherwise. */
export async function unlinkWearableProvider(
  tenantId: string,
  ownerSubject: string,
  provider: string,
  providerUserId: string,
): Promise<void> {
  const key = `${tenantId}::${provider}::${providerUserId}`;
  const existing = await links.get(key);
  if (existing && existing.ownerSubject === ownerSubject) {
    await links.delete(key);
    log.info('kicktodo_wearable_unlinked', { provider });
  }
}

/** The acting subject's provider links (for a "manage my devices" read). */
export async function listWearableLinksForSubject(tenantId: string, ownerSubject: string): Promise<WearableLink[]> {
  if (!tenantId || !ownerSubject) return [];
  return (await links.listForTenantIndexed(tenantId)).filter((l) => l.ownerSubject === ownerSubject);
}

/** ADR 0381 erasure hop: drop every provider link the subject owns. Bounded
 *  tenant-slice scan (erasure frequency, off the hot path). */
export async function eraseWearableLinksForSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  for (const l of (await links.listForTenantIndexed(tenantId)).filter((x) => x.ownerSubject === subjectKey)) {
    await links.delete(`${l.tenantId}::${l.provider}::${l.providerUserId}`);
  }
}

// ADR 0381 — register the link eraser as its OWN registrant (the seam is
// multi-registrant), avoiding an integrationService↔wearableLinkService import cycle.
// Runs at module load (imported by routes.ts, whose registerRoutes runs regardless
// of toggle — so erasure works even when kicktodo-integrations is off).
registerSubjectEraser(eraseWearableLinksForSubject);

/** Test-only reset. */
export async function __resetWearableLinks(): Promise<void> {
  await links.__clear();
}
