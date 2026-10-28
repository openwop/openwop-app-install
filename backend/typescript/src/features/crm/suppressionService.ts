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

/** ADR 0955 D2 (J2) — the channel a suppression row stops. */
export type SuppressionChannel = 'email' | 'sms';

export interface SuppressionEntry {
  /** The natural key, one row per (channel, sender scope, address):
   *  - legacy tenant-wide email: `${tenantId}::${emailLower}` (every row before ADR 0955);
   *  - everything else: `${tenantId}::#${channel}:${senderOrgId || '*'}:${address}` (`scopedKeyOf`). */
  key: string;
  tenantId: string;
  /** Lower-cased, trimmed address on an email row. `''` on an SMS row (the number is `address`). */
  email: string;
  /** ADR 0955 D2 — absent on rows written before it, which read as `'email'`. */
  channel?: SuppressionChannel;
  /** ADR 0955 D2 — the normalized address the row stops (email lower-cased, SMS E.164).
   *  Absent on legacy rows, which read as `email`. */
  address?: string;
  /** ADR 0955 D2 — the client org whose SENDER this row stops. Absent ⇒ tenant-wide (every
   *  sender in the workspace), which is what every row before ADR 0955 is. */
  senderOrgId?: string;
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

// ADR 0837 (prefix sweep) — filtered on the row's tenant too: a prefix is not an identity.
const actualCount = async (tenantId: string): Promise<number> => (await suppressions.listByPrefix(`${tenantId}::`)).filter((s) => s.tenantId === tenantId).length;

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

function assertSuppressionIdentity(
  row: SuppressionEntry | null | undefined, tenantId: string, address: string,
  channel: SuppressionChannel = 'email', senderOrgId?: string,
): void {
  if (row && (row.key !== rowKeyOf(tenantId, channel, address, senderOrgId)
      || !rowMatches(row, tenantId, channel, address, senderOrgId) || !REASONS.includes(row.reason))) {
    throw new OpenwopError('conflict', 'Suppression identity is inconsistent; delivery remains blocked.', 409);
  }
}

/** ADR 0955 D2 — an SMS address is E.164: `+`, a non-zero country digit, 8–15 digits in all. */
const E164 = /^\+[1-9]\d{7,14}$/;

/** ADR 0955 D2 — the normalized address for a channel, or `''` when it is not one
 *  (an email without `@`, a number that is not E.164 after stripping punctuation). */
export function normalizeChannelAddress(channel: SuppressionChannel, raw: string): string {
  if (channel === 'email') {
    const e = normalizeEmail(raw);
    return e.includes('@') ? e : '';
  }
  const n = raw.trim().replace(/[^\d+]/g, '');
  return E164.test(n) ? n : '';
}

/**
 * ADR 0955 D2 — the key of every row that is NOT a legacy tenant-wide email row. The `#`
 * marker keeps these out of the legacy `${tenant}::${email}` space in practice; readers
 * verify the row's own `channel`/`senderOrgId`/`address` after the point get, so even a
 * contrived collision can only MISS a row, never attribute one row to another scope.
 * ADDRESS before scope, so every scope of one address is one prefix (`addressPrefixOf`):
 * the SMS exit guard (P1) needs "any row for this number" when it cannot name the sender.
 */
const scopedKeyOf = (tenantId: string, channel: SuppressionChannel, address: string, senderOrgId?: string): string =>
  `${tenantId}::#${channel}:${address}:${senderOrgId || '*'}`;
const addressPrefixOf = (tenantId: string, channel: SuppressionChannel, address: string): string => `${tenantId}::#${channel}:${address}:`;

/** The key a (channel, address, sender) row lives under. Tenant-wide email keeps the legacy key. */
const rowKeyOf = (tenantId: string, channel: SuppressionChannel, address: string, senderOrgId?: string): string =>
  channel === 'email' && !senderOrgId ? keyOf(tenantId, address) : scopedKeyOf(tenantId, channel, address, senderOrgId);

const channelOfRow = (r: SuppressionEntry): SuppressionChannel => r.channel ?? 'email';
const addressOfRow = (r: SuppressionEntry): string => r.address ?? r.email;

/** Does a stored row really describe this (channel, address, sender) scope? */
const rowMatches = (r: SuppressionEntry | null | undefined, tenantId: string, channel: SuppressionChannel, address: string, senderOrgId?: string): r is SuppressionEntry =>
  !!r && r.tenantId === tenantId && channelOfRow(r) === channel && addressOfRow(r) === address && (r.senderOrgId ?? '') === (senderOrgId ?? '');

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
  assertSuppressionIdentity(row, tenantId, e);
  return !!row;
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
export async function suppressionBlocksSend(tenantId: string, email: string, opts: { purpose?: 'marketing' | 'transactional' } = {}): Promise<SuppressionCheck> {
  // ADR 0955 D2 — the email, tenant-wide case of `suppressionCheck`. Every caller before
  // ADR 0955 sends from no particular client sender, so only tenant-wide rows apply.
  return suppressionCheck(tenantId, { channel: 'email', address: email, ...(opts.purpose ? { purpose: opts.purpose } : {}) });
}

/**
 * ADR 0955 D2 (J2) — the ONE suppression read for a send on any channel, optionally from one
 * client's sender. A row stops the send when it is tenant-wide for this (channel, address), or
 * scoped to this exact `senderOrgId`. At most two point reads; never a scan.
 *
 * `purpose:'transactional'`: an `unsubscribed` row is a marketing opt-out and does not block
 * (ADR 0905 D7, EMWF-18). Bounces, complaints and manual holds block every purpose.
 * A read failure is `'unreadable'` (CRM-4 / fold-in B5): refused, never claimed as a choice.
 */
export async function suppressionCheck(
  tenantId: string,
  input: {
    channel: SuppressionChannel; address: string; senderOrgId?: string; purpose?: 'marketing' | 'transactional';
    /** The caller cannot name the sender (an SMS sent from a number bound to no client): every
     *  row for the address blocks, whatever its scope. One prefix read on the address. */
    anySender?: boolean;
  },
): Promise<SuppressionCheck> {
  const address = input.channel === 'email' ? normalizeEmail(input.address) : normalizeChannelAddress('sms', input.address);
  if (!address) return 'clear'; // nothing to key (the eligibility check refuses `no_address` before this)
  const blocks = (r: SuppressionEntry): boolean => input.purpose !== 'transactional' || r.reason !== 'unsubscribed';
  try {
    if (input.anySender) {
      const rows = await suppressions.listByPrefix(addressPrefixOf(tenantId, input.channel, address));
      for (const row of rows) {
        assertSuppressionIdentity(row, tenantId, address, input.channel, row.senderOrgId);
        if (blocks(row)) return 'suppressed';
      }
      if (input.channel === 'email') {
        const legacy = await suppressions.get(keyOf(tenantId, address));
        assertSuppressionIdentity(legacy, tenantId, address);
        if (legacy && blocks(legacy)) return 'suppressed';
      }
      return 'clear';
    }
    const wide = await suppressions.get(rowKeyOf(tenantId, input.channel, address));
    assertSuppressionIdentity(wide, tenantId, address, input.channel);
    if (wide && blocks(wide)) return 'suppressed';
    if (input.senderOrgId) {
      const scoped = await suppressions.get(scopedKeyOf(tenantId, input.channel, address, input.senderOrgId));
      assertSuppressionIdentity(scoped, tenantId, address, input.channel, input.senderOrgId);
      if (scoped && blocks(scoped)) return 'suppressed';
    }
    return 'clear';
  } catch (err) {
    log.error('suppression_read_failed_refusing_send', {
      tenantId, channel: input.channel, error: err instanceof Error ? err.message : String(err),
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
  /** ADR 0955 D2 — absent ⇒ a tenant-wide EMAIL row, exactly as every writer before it. */
  scope: { channel?: SuppressionChannel; senderOrgId?: string } = {},
): Promise<SuppressionEntry> {
  const channel = scope.channel ?? 'email';
  const senderOrgId = cleanString(scope.senderOrgId, 160) || undefined;
  const e = normalizeChannelAddress(channel, email);
  if (!e) {
    throw new OpenwopError('validation_error', channel === 'email' ? 'A valid email address is required.' : 'A phone number in E.164 form (+ and country code) is required.', 400, { field: channel === 'email' ? 'email' : 'address' });
  }
  if (!REASONS.includes(reason)) throw new OpenwopError('validation_error', `reason must be one of ${REASONS.join(' | ')}.`, 400, { field: 'reason' });
  const rowKey = rowKeyOf(tenantId, channel, e, senderOrgId);
  const existing = await suppressions.get(rowKey);
  assertSuppressionIdentity(existing, tenantId, e, channel, senderOrgId);
  if (!existing) {
    // SUPP-1: fast O(1) counter check; only if it SAYS full do we pay the scan
    // to verify — the counter can drift high and must never falsely refuse a
    // (compliance-critical) suppression.
    const cap = maxPerTenant();
    if (await fastCount(tenantId) >= cap && await reconcileCount(tenantId) >= cap) {
      throw new OpenwopError('validation_error', 'Suppression list is full.', 400, { cap });
    }
  }
  const legacy = channel === 'email' && !senderOrgId;
  const entry: SuppressionEntry = {
    key: rowKey,
    tenantId,
    email: channel === 'email' ? e : '',
    // A legacy-keyed row stays byte-shaped as before (no new fields); a scoped row says what it is.
    ...(legacy ? {} : { channel, address: e, ...(senderOrgId ? { senderOrgId } : {}) }),
    reason,
    ...(cleanString(note, 400) ? { note: cleanString(note, 400) } : {}),
    actor,
    at: new Date().toISOString(),
  };
  let current = existing;
  for (let attempt = 0; attempt < 5; attempt++) {
    assertSuppressionIdentity(current, tenantId, e, channel, senderOrgId);
    // An unsubscribe narrows marketing only. It cannot erase a bounce, complaint
    // or manual hold, which also protects transactional delivery. Re-evaluate on
    // every lost CAS; unreadable state must never be treated as an absent hold.
    if (reason === 'unsubscribed' && current && current.reason !== 'unsubscribed') return current;
    if (await suppressions.compareAndSwap(current, entry)) {
      if (!current) await bumpCount(tenantId, +1);
      return entry;
    }
    current = await suppressions.get(entry.key);
  }
  throw new OpenwopError('conflict', 'Suppression changed concurrently; retry the request.', 409);
}

/** Remove a suppression — ONLY 'manual' rows are operator-removable; system
 *  reasons (unsubscribed/bounced/complaint) stay unless the subject re-opts-in
 *  through a consent-bearing flow (not an admin click — the honesty rule). */
export async function removeSuppression(tenantId: string, email: string, opts: { force?: boolean; channel?: SuppressionChannel; senderOrgId?: string } = {}): Promise<boolean> {
  const channel = opts.channel ?? 'email';
  const address = channel === 'email' ? normalizeEmail(email) : normalizeChannelAddress('sms', email);
  if (!address) return false;
  const row = await suppressions.get(rowKeyOf(tenantId, channel, address, opts.senderOrgId)).catch(() => undefined);
  if (!rowMatches(row, tenantId, channel, address, opts.senderOrgId)) return false;
  if (row.reason !== 'manual' && !opts.force) {
    throw new OpenwopError('validation_error', `A '${row.reason}' suppression can only be lifted by the subject re-opting in.`, 400, { reason: row.reason });
  }
  const deleted = await suppressions.delete(row.key);
  if (deleted) await bumpCount(tenantId, -1); // SUPP-1: keep the fast-path counter in sync
  return deleted;
}

/**
 * ADR 0955 D3 — lift a row only if `may(row)` says so, for a lifting flow that may not
 * remove every reason (an SMS START lifts only the opt-out a STOP to that sender wrote).
 */
export async function removeSuppressionIf(
  tenantId: string,
  address: string,
  scope: { channel: SuppressionChannel; senderOrgId?: string },
  may: (row: SuppressionEntry) => boolean,
): Promise<boolean> {
  const a = scope.channel === 'email' ? normalizeEmail(address) : normalizeChannelAddress('sms', address);
  if (!a) return false;
  const row = await suppressions.get(rowKeyOf(tenantId, scope.channel, a, scope.senderOrgId));
  if (!rowMatches(row, tenantId, scope.channel, a, scope.senderOrgId) || !may(row)) return false;
  const deleted = await suppressions.compareAndDelete(row);
  if (deleted) await bumpCount(tenantId, -1);
  return deleted;
}

/** Tenant list, newest-first. ADR 0955 D2: every row carries its `channel` and `address`
 *  (a legacy row reads as a tenant-wide email row), so a consumer never has to infer them. */
export async function listSuppressions(tenantId: string): Promise<SuppressionEntry[]> {
  const all = await suppressions.listByPrefix(`${tenantId}::`);
  return all
    .filter((s) => s.tenantId === tenantId)
    .map((s) => ({ ...s, channel: channelOfRow(s), address: addressOfRow(s) }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** ADR 0955 D2 — the scoped (non-legacy) rows for a tenant: the `#` keyspace only, for the
 *  DSAR redaction leg (`crm/erasure.ts`), which point-reads the legacy rows itself. */
export async function listScopedSuppressions(tenantId: string): Promise<SuppressionEntry[]> {
  return (await suppressions.listByPrefix(`${tenantId}::#`)).filter((s) => s.tenantId === tenantId);
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
