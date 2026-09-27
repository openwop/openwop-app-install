/**
 * Approval delegations — "act on my behalf" coverage for approval gates
 * (ADR 0198, the Microsoft-canon approvals-depth phase).
 *
 * ONE record type covers both named delegation and out-of-office coverage:
 * OOO IS a delegation with a time window. A delegation makes `toSubject`
 * eligible wherever `fromSubject` is an eligible approver, for the window
 * [startsAt, endsAt) and until revoked.
 *
 * The delegation JOIN lives in exactly one place — `approverResolution.ts`,
 * the single eligibility authority (ADR 0075 §D1) — so pre-flight,
 * notification fan-out, and decision-time eligibility can never disagree
 * about coverage. This module only owns the durable records.
 *
 * Integrity invariant (ADR 0198 §identity): a delegation NEVER multiplies
 * votes. Each vote consumes exactly one identity — the voter themselves when
 * independently eligible, else the ONE principal they act for (explicit
 * `actedFor` required when they cover several) — and the quorum ledger dedups
 * on the CONSUMED identity, so a principal+delegate pair can only ever count
 * once. See `consumeVoteIdentity` in approverResolution.ts.
 *
 * Host-extension, non-normative. RFC 0104's routing fields are untouched;
 * delegation is host-side resolution (the RFC's "union of resolved subjects"
 * becomes union ∪ active delegates). No wire change; no RFC needed.
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';
import { OpenwopError } from '../types.js';

/** ADR 0464 — the sentinel an anonymized attribution / redacted reason becomes. */
const ERASED = '[erased]';

export interface ApprovalDelegation {
  /** `dlg:<uuid>`. */
  delegationId: string;
  tenantId: string;
  /** The principal whose approval authority is covered. */
  fromSubject: string;
  /** The delegate who may act for `fromSubject` while the window is active. */
  toSubject: string;
  /** ISO instants; active while startsAt <= now < endsAt and not revoked. */
  startsAt: string;
  endsAt: string;
  reason?: string;
  createdBy: string;
  createdAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

// Tenant-prefixed key so reads are tenant-slice scans (listByPrefix), never a
// cross-tenant list() on the resolution hot path.
const delegations = new DurableCollection<ApprovalDelegation>(
  'approval:delegation',
  (d) => `${d.tenantId}:${d.delegationId}`,
);

const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000; // a year — OOO, not abdication

function parseIso(label: string, value: unknown): number {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new OpenwopError('validation_error', `${label} must be an ISO-8601 instant.`, 400, { [label]: value });
  }
  return Date.parse(value);
}

export async function createDelegation(input: {
  tenantId: string;
  fromSubject: string;
  toSubject: string;
  startsAt: string;
  endsAt: string;
  reason?: string;
  createdBy: string;
}): Promise<ApprovalDelegation> {
  const from = input.fromSubject?.trim();
  const to = input.toSubject?.trim();
  if (!from || !to) {
    throw new OpenwopError('validation_error', 'fromSubject and toSubject are required.', 400, {});
  }
  if (from === to) {
    throw new OpenwopError('validation_error', 'A delegation to yourself has no effect.', 400, {});
  }
  const starts = parseIso('startsAt', input.startsAt);
  const ends = parseIso('endsAt', input.endsAt);
  if (ends <= starts) {
    throw new OpenwopError('validation_error', 'endsAt must be after startsAt.', 400, {});
  }
  if (ends - starts > MAX_WINDOW_MS) {
    throw new OpenwopError('validation_error', 'A delegation window may cover at most one year.', 400, {});
  }
  const record: ApprovalDelegation = {
    delegationId: `dlg:${randomUUID()}`,
    tenantId: input.tenantId,
    fromSubject: from,
    toSubject: to,
    startsAt: new Date(starts).toISOString(),
    endsAt: new Date(ends).toISOString(),
    ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 500) } : {}),
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  await delegations.put(record);
  return record;
}

export async function getDelegation(tenantId: string, delegationId: string): Promise<ApprovalDelegation | null> {
  return delegations.get(`${tenantId}:${delegationId}`);
}

/** Revoke (idempotent — revoking an already-revoked record is a no-op). */
export async function revokeDelegation(tenantId: string, delegationId: string, revokedBy: string): Promise<ApprovalDelegation> {
  const existing = await getDelegation(tenantId, delegationId);
  if (!existing) {
    throw new OpenwopError('not_found', 'Delegation not found.', 404, { delegationId });
  }
  if (existing.revokedAt) return existing;
  const revoked: ApprovalDelegation = { ...existing, revokedAt: new Date().toISOString(), revokedBy };
  await delegations.put(revoked);
  return revoked;
}

/** All of a tenant's delegations (newest first), optionally filtered to those
 *  from OR to `subject` (the self-service list view). */
export async function listDelegations(tenantId: string, opts: { subject?: string } = {}): Promise<ApprovalDelegation[]> {
  const rows = await delegations.listByPrefix(`${tenantId}:`);
  const filtered = opts.subject
    ? rows.filter((d) => d.fromSubject === opts.subject || d.toSubject === opts.subject)
    : rows;
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface ActiveDelegations {
  /** principal → delegates covering them right now. */
  byPrincipal: Map<string, string[]>;
  /** delegate → principals they cover right now. */
  byDelegate: Map<string, string[]>;
}

/** The tenant's ACTIVE delegation graph at `atIso` (defaults to now). Window
 *  and revocation are evaluated HERE, so every resolution — including the
 *  decide-time re-check — sees live validity (an expired window fails closed). */
export async function activeDelegations(tenantId: string, atIso?: string): Promise<ActiveDelegations> {
  const at = atIso ?? new Date().toISOString();
  const byPrincipal = new Map<string, string[]>();
  const byDelegate = new Map<string, string[]>();
  for (const d of await delegations.listByPrefix(`${tenantId}:`)) {
    if (d.revokedAt) continue;
    if (!(d.startsAt <= at && at < d.endsAt)) continue;
    byPrincipal.set(d.fromSubject, [...(byPrincipal.get(d.fromSubject) ?? []), d.toSubject]);
    byDelegate.set(d.toSubject, [...(byDelegate.get(d.toSubject) ?? []), d.fromSubject]);
  }
  return { byPrincipal, byDelegate };
}

/**
 * ADR 0464 — subject-erasure reach into the delegation store. A delegation exists
 * only to couple a principal and a delegate, so once either party is erased the row
 * is meaningless and is DELETED outright. Where the erased subject merely CREATED or
 * REVOKED someone else's delegation, that row still governs two other people, so it
 * is kept: the subject's attribution fields (`createdBy` / `revokedBy`) are
 * anonymized, and the free-text `reason` they authored is redacted. Registered at
 * module load (this module is imported at boot via the delegation routes); invoked
 * once per linked identity key. Tenant-scoped, idempotent, no notifications. Returns
 * the count touched.
 */
export async function eraseDelegationsForSubject(tenantId: string, subjectKey: string): Promise<number> {
  if (!tenantId || !subjectKey) return 0;
  // Match every subject-key form (raw + scoped) — the DSAR entry accepts either.
  const { forms } = subjectKeyForms(subjectKey);
  let touched = 0;
  for (const d of await delegations.listByPrefix(`${tenantId}:`)) {
    if (d.tenantId !== tenantId) continue;
    // A delegation TO or FROM the erased subject is meaningless → delete.
    if (forms.has(d.fromSubject) || forms.has(d.toSubject)) {
      await delegations.delete(`${d.tenantId}:${d.delegationId}`);
      touched += 1;
      continue;
    }
    // Otherwise the subject only touched someone else's row as its creator/revoker.
    let next = d;
    let changed = false;
    if (d.createdBy !== undefined && forms.has(d.createdBy)) {
      next = { ...next, createdBy: ERASED };
      changed = true;
      // The reason is authored by the creator — redact it with them.
      if (next.reason !== undefined && next.reason !== ERASED) next = { ...next, reason: ERASED };
    }
    if (d.revokedBy !== undefined && forms.has(d.revokedBy)) { next = { ...next, revokedBy: ERASED }; changed = true; }
    if (changed) { await delegations.put(next); touched += 1; }
  }
  return touched;
}
/** ADR 0464 — called from `registerHostSubjectErasers()` (one explicit boot list;
 *  module-load side effects can be silently lost to import-graph changes). */
export function registerApprovalDelegationsErasure(): void {
  registerSubjectEraser(async function eraseApprovalDelegations(tenantId, subjectKey) { await eraseDelegationsForSubject(tenantId, subjectKey); });
}

/** Test seam. */
export async function _clearDelegationsForTest(tenantId: string): Promise<void> {
  for (const d of await delegations.listByPrefix(`${tenantId}:`)) {
    await delegations.delete(`${d.tenantId}:${d.delegationId}`);
  }
}
