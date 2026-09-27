/**
 * WhatsApp compliance layer (ADR 0394 Phase 2).
 *
 * Meta's Business Solution Terms (effective 2026-01-15) prohibit external LLM
 * providers from TRAINING on WhatsApp message data. The structural v1
 * enforcement (correction-noted in the ADR): inbound WhatsApp messages will
 * not fire AI workflows for a tenant until an admin has recorded the
 * NO-TRAINING ATTESTATION — one per tenant, covering both postures:
 *   - managed keys: the platform configures no-train / zero-retention on the
 *     managed provider accounts (disclosed in OPENWOP-WHATSAPP.md so the
 *     operator's own Meta attestation is truthful);
 *   - BYOK: the platform cannot control the tenant's provider account, so the
 *     admin confirms training is disabled / zero-retention is enabled there.
 * The ADR's finer managed-allowlist filter refines this when a per-run
 * model-policy seam exists; the attestation gate is the fail-closed superset.
 *
 * Also owns the STOP/START keyword ladder — the inbound opt-out/opt-in flow
 * Meta requires to be immediate and fail-closed.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { mergeConsentCategories } from '../consent/consentService.js';
import { normalizeWaNumber } from './whatsappService.js';

const log = createLogger('features.whatsapp.compliance');

export interface WaAttestation {
  tenantId: string;
  /** The admin who confirmed the no-training posture. */
  attestedBy: string;
  attestedAt: string;
}
const attestations = new DurableCollection<WaAttestation>(
  'whatsapp:attestation',
  (a) => a.tenantId,
  undefined,
  (a) => a.tenantId,
);

export async function getAttestation(tenantId: string): Promise<WaAttestation | null> {
  return attestations.get(tenantId);
}

export async function recordNoTrainAttestation(tenantId: string, attestedBy: string): Promise<WaAttestation> {
  const attestation: WaAttestation = { tenantId, attestedBy, attestedAt: new Date().toISOString() };
  await attestations.put(attestation);
  log.info('whatsapp_no_train_attested', { tenantId, attestedBy });
  return attestation;
}

export async function revokeAttestation(tenantId: string): Promise<boolean> {
  return attestations.delete(tenantId);
}

/**
 * The inbound AI-dispatch gate: without the tenant attestation, a verified
 * inbound WhatsApp message is ACKED but does not fire the configured workflow
 * — WhatsApp message data structurally never reaches a model path the tenant
 * has not attested for. Fail-closed.
 */
export async function whatsappDispatchAllowed(tenantId: string): Promise<{ allow: true } | { allow: false; reason: string }> {
  const attestation = await attestations.get(tenantId);
  if (attestation) return { allow: true };
  return { allow: false, reason: 'no_train_attestation_missing' };
}

/** STOP-class keywords (Twilio's default stop words + common variants). */
const STOP_RE = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|parar|baja)\s*$/i;
/** START-class keywords — an explicit user re-opt-in. GRADE-CODE 2026-07-17:
 *  bare `yes` removed — a "yes" answering a support question must never be
 *  captured as a marketing re-opt-in; only unambiguous subscription verbs. */
const START_RE = /^\s*(start|unstop|subscribe)\s*$/i;

/**
 * Inbound keyword ladder (Phase 2): STOP revokes the `marketing.whatsapp`
 * consent immediately (fail-closed — the send gate denies from the next
 * message); START records an explicit re-opt-in (the keyword IS the explicit
 * per-number consent, captured with source+method for the Meta audit trail).
 * Non-keyword messages do nothing here. Returns what happened for the caller's
 * observability line.
 */
export async function applyInboundKeyword(tenantId: string, from: string, body: string): Promise<'opt-out' | 'opt-in' | null> {
  const subject = normalizeWaNumber(from);
  if (!subject) return null;
  const kind = STOP_RE.test(body) ? 'opt-out' : START_RE.test(body) ? 'opt-in' : null;
  if (!kind) return null;
  // GRADE-DATA 2026-07-17 — CAS-merge (never latest-wins): a STOP racing any
  // concurrent consent write must not be silently overwritten (Meta's
  // immediate-opt-out rule). Only the whatsapp channel flips; every other
  // category is preserved by the merge itself.
  try {
    await mergeConsentCategories({
      tenantId,
      subjectKey: subject,
      categories: { 'marketing.whatsapp': kind === 'opt-in' },
      source: `whatsapp:keyword:${kind}`,
    });
  } catch (err) {
    // ADR 0657 D10 — an erased number's keyword cannot be written (the tombstone already
    // denies every send); log the refusal, never a webhook 500, never a re-inserted row.
    if ((err as { code?: string }).code === 'subject_erased') { log.info('whatsapp_keyword_consent_refused_erased', { tenantId, kind }); return null; }
    throw err;
  }
  log.info('whatsapp_keyword_consent', { tenantId, kind });
  await emitHostEvent({ type: `host.whatsapp.consent.${kind}`, tenantId, payload: { channel: 'whatsapp', kind } });
  return kind;
}

/** Test-only. */
export async function __resetWhatsAppCompliance(): Promise<void> {
  await attestations.__clear();
}
