/**
 * CRM suppression list (ADR 0217 / campaign gap plan §5C C3) — the tenant-wide,
 * reason-coded do-not-contact ledger for email-keyed marketing sends.
 *
 * ONE owner for "may we market to this address?": every marketing egress path
 * subtracts this list — the email campaign send (`emailService.sendCampaign`,
 * skip reason 'suppressed') and the ads audience upload
 * (`campaign-connectors/audienceService`). Distinct from CONSENT (a subject's
 * recorded choice, `consentService`): suppression is the operational overlay —
 * bounces, complaints, unsubscribes, and manual holds — that stays enforced
 * even when the consent feature is toggled off (fail-closed for known-bad
 * addresses). Keyed by lower-cased email; PII-minimal (the address itself is
 * the datum; reason + timestamps only, never message content).
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.crm.suppression');

export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complaint' | 'manual';
const REASONS: readonly SuppressionReason[] = ['unsubscribed', 'bounced', 'complaint', 'manual'];

export interface SuppressionEntry {
  /** `${tenantId}::${emailLower}` — the natural key (one row per address). */
  key: string;
  tenantId: string;
  /** Lower-cased, trimmed address. */
  email: string;
  reason: SuppressionReason;
  /** Free-form context (e.g. the campaignId the unsubscribe came from). */
  note?: string;
  actor: string;
  at: string;
}

const suppressions = new DurableCollection<SuppressionEntry>('crm:suppression', (s) => s.key);

const DEFAULT_MAX_PER_TENANT = 50_000;
/** The per-tenant cap (env-overridable for ops tuning + tests). */
const maxPerTenant = (): number => {
  const raw = Number(process.env.OPENWOP_SUPPRESSION_MAX);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_PER_TENANT;
};

/**
 * SUPP-1 — a per-tenant suppression COUNTER so the cap check is O(1) instead of
 * a full `listByPrefix` scan on every new insert (a hot bounce/unsubscribe path
 * at the 50k ceiling). This service is the sole writer to the list, so the
 * counter (when present) tracks the list length. It is a best-effort FAST PATH,
 * never the source of truth: a suppression is compliance-critical, so the cap
 * NEVER refuses a new address on the counter alone — at the boundary it
 * scan-verifies + reconciles. Lazily seeded from the actual list once per tenant.
 */
interface SuppressionCount { key: string; count: number }
// tenantOf: the row key IS the tenantId (`{ key: tenantId, count }`), so tenant
// teardown reaches this count row (else it orphans — the RATCHET-BLINDSPOT class).
const suppressionCounts = new DurableCollection<SuppressionCount>('crm:suppression-count', (c) => c.key, undefined, (c) => c.key);

const actualCount = async (tenantId: string): Promise<number> => (await suppressions.listByPrefix(`${tenantId}::`)).length;

/** O(1) after a one-time lazy seed from the real list. */
async function fastCount(tenantId: string): Promise<number> {
  const row = await suppressionCounts.get(tenantId).catch(() => undefined);
  if (row) return row.count;
  const n = await actualCount(tenantId);
  await suppressionCounts.compareAndSwap(null, { key: tenantId, count: n }).catch(() => {});
  return (await suppressionCounts.get(tenantId).catch(() => undefined))?.count ?? n;
}

/** Best-effort CAS delta — never throws (the list is truth). If the counter is
 *  absent, no-op: the next `fastCount` seeds it from the post-mutation list. */
async function bumpCount(tenantId: string, delta: number): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const existing = await suppressionCounts.get(tenantId).catch(() => undefined);
    if (!existing) return;
    const next: SuppressionCount = { key: tenantId, count: Math.max(0, existing.count + delta) };
    if (await suppressionCounts.compareAndSwap(existing, next)) return;
  }
}

/** Reconcile the counter to the real list length (used at the cap boundary). */
async function reconcileCount(tenantId: string): Promise<number> {
  const actual = await actualCount(tenantId);
  const existing = await suppressionCounts.get(tenantId).catch(() => undefined);
  await suppressionCounts.compareAndSwap(existing ?? null, { key: tenantId, count: actual }).catch(() => {});
  return actual;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
const keyOf = (tenantId: string, email: string): string => `${tenantId}::${normalizeEmail(email)}`;

/**
 * Is this address suppressed for the tenant? The ONE read every marketing egress
 * path calls. Fail-open only on a malformed address (nothing to key).
 *
 * CRM-4 — a storage error now PROPAGATES. This was
 * `.catch(() => undefined)` → `false` → "not suppressed" → the send proceeds,
 * while this file's header ("fail-closed for known-bad addresses"), this
 * docstring, and all three egress call sites (`email/emailService.ts`,
 * `campaign-connectors/audienceService.ts`, `campaign-journeys/journeyService.ts`)
 * each claimed the opposite. A transient KV read failure therefore emailed a hard
 * bounce or a registered complainant. `DurableCollection.get` returns `null` for a
 * missing row, so the `.catch` was never doing absent-key handling — it could only
 * ever swallow a real read failure. A suppression check that cannot read its store
 * must refuse the send, and the callers' `try` already turns that into a skip.
 */
export async function isSuppressed(tenantId: string, email: string): Promise<boolean> {
  const e = normalizeEmail(email);
  if (!e) return false;
  const row = await suppressions.get(keyOf(tenantId, e));
  return !!row && row.tenantId === tenantId;
}

/**
 * The outcome of the pre-send suppression check. Three states, not two — and the
 * third one is the whole point of the fold-in (B5).
 *
 *  - `'clear'`      — the store answered, the address is not suppressed. Send.
 *  - `'suppressed'` — the store answered, the person asked us to stop. TERMINAL.
 *  - `'unreadable'` — the store could not be read. The send is still refused, but
 *    this is NOT a decision about the recipient and must never be recorded as one.
 */
export type SuppressionCheck = 'clear' | 'suppressed' | 'unreadable';

/**
 * CRM-4 — the ONE thing a marketing EGRESS path calls. Fail-closed by
 * construction: an unreadable store BLOCKS the send instead of waving it through,
 * and the failure is logged so an operator can tell "held back because we could not
 * check" from "held back because they asked us to stop".
 *
 * Why a wrapper rather than letting `isSuppressed` throw at the call sites: a
 * campaign send loops over thousands of recipients, and a raw throw would abort
 * the whole run mid-batch — turning one unreadable row into an outage and, worse,
 * leaving the partially-sent batch's remainder in an undefined state. Refusing
 * PER RECIPIENT is bounded, resumable, and is what "the send must not proceed"
 * actually means here. `isSuppressed` stays strict for callers that want to see
 * the error (the admin list/summary paths).
 *
 * FOLD-IN B5 — this used to return a bare `boolean`, and the ONLY place the
 * distinction survived was a server log line. Every caller then recorded the
 * refusal as `suppressed`, which is a durable, terminal, person-attributed claim:
 * `sendCampaign` wrote `log('skipped', 'suppressed')`, `skipped` counts as
 * prior-terminal, and no continuation pass ever retried the recipient. So one
 * transient KV blip permanently excluded a real person from that campaign
 * generation AND left a ledger row saying they had asked to stop — a lie about a
 * consent decision, in the store an auditor reads. Returning the third state is
 * what lets a caller refuse the send WITHOUT making a claim about the recipient.
 */
export async function suppressionBlocksSend(tenantId: string, email: string): Promise<SuppressionCheck> {
  try {
    return (await isSuppressed(tenantId, email)) ? 'suppressed' : 'clear';
  } catch (err) {
    log.error('suppression_read_failed_refusing_send', {
      tenantId, error: err instanceof Error ? err.message : String(err),
    });
    return 'unreadable';
  }
}

/** Upsert a suppression (idempotent — re-suppressing updates reason/note). */
export async function addSuppression(
  tenantId: string,
  email: string,
  reason: SuppressionReason,
  actor: string,
  note?: string,
): Promise<SuppressionEntry> {
  const e = normalizeEmail(email);
  if (!e || !e.includes('@')) throw new OpenwopError('validation_error', 'A valid email address is required.', 400, { field: 'email' });
  if (!REASONS.includes(reason)) throw new OpenwopError('validation_error', `reason must be one of ${REASONS.join(' | ')}.`, 400, { field: 'reason' });
  const existing = await suppressions.get(keyOf(tenantId, e)).catch(() => undefined);
  if (!existing) {
    // SUPP-1: fast O(1) counter check; only if it SAYS full do we pay the scan
    // to verify — the counter can drift high and must never falsely refuse a
    // (compliance-critical) suppression.
    const cap = maxPerTenant();
    if (await fastCount(tenantId) >= cap && await reconcileCount(tenantId) >= cap) {
      throw new OpenwopError('validation_error', 'Suppression list is full.', 400, { cap });
    }
  }
  const entry: SuppressionEntry = {
    key: keyOf(tenantId, e),
    tenantId,
    email: e,
    reason,
    ...(cleanString(note, 400) ? { note: cleanString(note, 400) } : {}),
    actor,
    at: new Date().toISOString(),
  };
  await suppressions.put(entry);
  if (!existing) await bumpCount(tenantId, +1); // maintain the fast-path counter
  return entry;
}

/** Remove a suppression — ONLY 'manual' rows are operator-removable; system
 *  reasons (unsubscribed/bounced/complaint) stay unless the subject re-opts-in
 *  through a consent-bearing flow (not an admin click — the honesty rule). */
export async function removeSuppression(tenantId: string, email: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const row = await suppressions.get(keyOf(tenantId, email)).catch(() => undefined);
  if (!row || row.tenantId !== tenantId) return false;
  if (row.reason !== 'manual' && !opts.force) {
    throw new OpenwopError('validation_error', `A '${row.reason}' suppression can only be lifted by the subject re-opting in.`, 400, { reason: row.reason });
  }
  const deleted = await suppressions.delete(row.key);
  if (deleted) await bumpCount(tenantId, -1); // SUPP-1: keep the fast-path counter in sync
  return deleted;
}

/** Tenant list, newest-first. */
export async function listSuppressions(tenantId: string): Promise<SuppressionEntry[]> {
  const all = await suppressions.listByPrefix(`${tenantId}::`);
  return all.filter((s) => s.tenantId === tenantId).sort((a, b) => b.at.localeCompare(a.at));
}

/** ADR 0251: a suppression-CAUSE projection over the same rows `listSuppressions`
 *  returns — no parallel read model, no new store. Grouped by REASON (the cause)
 *  + a coarse SOURCE bucket derived from the actor (webhook / soft-escalation /
 *  campaign / manual / …). Counts + timestamps only — NO addresses — so the
 *  summary carries no PII (the full per-address list stays behind the authed
 *  `GET /crm/suppressions`). */
export interface SuppressionSummary {
  total: number;
  /** Every reason present with a zero baseline, so a caller can render all four. */
  byReason: Record<SuppressionReason, number>;
  /** Coarse origin buckets, highest-count first. */
  bySource: Array<{ source: string; count: number }>;
  /** ISO timestamp of the most recent suppression, or null when the list is empty. */
  newestAt: string | null;
}

/** Coarse origin bucket from the free-form actor. Soft-escalation is special-cased
 *  (its actor is `webhook:<provider>:soft-escalation`) so it reads distinctly from
 *  an immediate hard-bounce `webhook:<provider>`. */
function sourceOf(actor: string): string {
  if (actor.includes('soft-escalation')) return 'soft-escalation';
  const head = actor.split(':')[0]?.trim();
  return head || 'other';
}

export async function suppressionSummary(tenantId: string): Promise<SuppressionSummary> {
  const rows = await listSuppressions(tenantId);
  const byReason: Record<SuppressionReason, number> = { unsubscribed: 0, bounced: 0, complaint: 0, manual: 0 };
  const sourceCounts = new Map<string, number>();
  let newestAt: string | null = null;
  for (const r of rows) {
    byReason[r.reason] += 1;
    const source = sourceOf(r.actor);
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    if (newestAt === null || r.at > newestAt) newestAt = r.at;
  }
  const bySource = [...sourceCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  return { total: rows.length, byReason, bySource, newestAt };
}

/** Test-only. */
export async function __clearSuppressions(): Promise<void> {
  await suppressions.__clear();
  await suppressionCounts.__clear();
}
