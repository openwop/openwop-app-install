/**
 * Deal claims — a deal pays at most once per plan (ADR 1034 D4).
 *
 * The statement id embeds its period (`planId:subjectId:period`), and a period is either
 * `YYYY-MM` or `YYYY-Qn`. So `plan:rep:2026-02` and `plan:rep:2026-Q1` were two statements
 * over the same February deals, each approvable and payable on its own. A claim row per
 * `(planId, dealId)` is taken by an insert-if-absent CAS when a statement is approved;
 * a second statement of the same plan cannot then claim the deal. It is a CAS rather than a
 * scan because two approvals racing each other both pass a scan.
 *
 * Plans with DIFFERENT assignments may still both pay a deal (a role plan plus a rep plan
 * is a stacking the user chose to allow); that is surfaced on the review card instead.
 */

import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { validateDealClaim } from './rowGuards.js';
import { OpenwopError } from '../../../types.js';

export interface DealClaim {
  claimId: string; // `dc1|<planId.length>|<planId>|<dealId>` (see dealClaimId)
  tenantId: string;
  orgId: string;
  planId: string;
  dealId: string;
  /** The statement that committed the deal. Re-pointed by subject erasure. */
  statementId: string;
  at: string;
}

const claims = new DurableCollection<DealClaim>('commissions:deal-claim', (c) => c.claimId, validateDealClaim, (c) => c.tenantId);

// Length-prefixed, never a NUL separator: the id is the `host_ext_kv.k` TEXT primary key,
// and Postgres TEXT cannot store 0x00 (grade-code B1 — the first cut's NUL key would have
// failed every approval on Cloud SQL while the SQLite/in-memory test lanes stayed green).
export const dealClaimId = (planId: string, dealId: string): string => `dc1|${planId.length}|${planId}|${dealId}`;

/** Every claim in one plan (tenant + org scoped). */
export async function listPlanClaims(tenantId: string, orgId: string, planId: string): Promise<DealClaim[]> {
  return (await claims.listForTenantIndexed(tenantId)).filter((c) => c.tenantId === tenantId && c.orgId === orgId && c.planId === planId);
}

/**
 * Claim `dealIds` for `statementId`. Returns the claims THIS call inserted and the deals
 * another statement already holds.
 * A claim already held by the same statement counts as held, which keeps a retry idempotent.
 */
export async function claimDeals(
  tenantId: string, orgId: string, planId: string, statementId: string, dealIds: readonly string[], at: string,
): Promise<{ inserted: DealClaim[]; heldElsewhere: string[] }> {
  const inserted: DealClaim[] = [];
  const heldElsewhere: string[] = [];
  for (const dealId of new Set(dealIds)) {
    const claim: DealClaim = { claimId: dealClaimId(planId, dealId), tenantId, orgId, planId, dealId, statementId, at };
    if (await claims.compareAndSwap(null, claim)) { inserted.push(claim); continue; }
    const current = await claims.get(claim.claimId);
    if (!current || current.tenantId !== tenantId || current.statementId !== statementId) heldElsewhere.push(dealId);
  }
  return { inserted, heldElsewhere };
}

/**
 * Release the claims a DRAFT statement holds, except for `keepDealIds`. Called when a draft
 * is recomputed (deals it no longer contains) and when its review is rejected (it pays
 * nothing). Each is a compare-and-delete of the exact row.
 *
 * There is deliberately NO "release what this attempt inserted" on a failed approval
 * (grade-code H1): that was check-then-act — it read the statement's status, then deleted —
 * so a concurrent approval of the same statement could flip in the gap and be left
 * approved with no claims. A failed attempt's claims stay bound to the statement, which is
 * still the statement that wants those deals; they are freed only by the two lanes above.
 * And the PAY gate re-claims, so even an approved statement that somehow lost a claim
 * cannot be paid while another statement holds it.
 */
export async function releaseStatementClaims(tenantId: string, statementId: string, keepDealIds: ReadonlySet<string> = new Set()): Promise<number> {
  let released = 0;
  for (const c of await claims.listForTenantIndexed(tenantId)) {
    if (c.tenantId !== tenantId || c.statementId !== statementId || keepDealIds.has(c.dealId)) continue;
    if (await claims.compareAndDelete(c)) released += 1;
  }
  return released;
}

/** Subject erasure re-keys a statement; its claims follow it. */
export async function repointClaims(tenantId: string, fromStatementId: string, toStatementId: string): Promise<void> {
  for (const listed of await claims.listForTenantIndexed(tenantId)) {
    if (listed.tenantId !== tenantId || listed.statementId !== fromStatementId) continue;
    // Closing grade-code — a lost CAS is retried on a fresh read, never ignored: a claim
    // left on the old id becomes an orphan, and the re-keyed statement could then never be
    // marked paid (its pay gate would find the deal "held elsewhere"). Exhausted → 409, so
    // the erasure job retries.
    let c: DealClaim | null = listed;
    let done = false;
    for (let attempt = 0; attempt < 5 && c; attempt += 1) {
      if (c.statementId !== fromStatementId) { done = true; break; } // someone else moved it
      if (await claims.compareAndSwap(c, { ...c, statementId: toStatementId })) { done = true; break; }
      c = await claims.get(listed.claimId);
    }
    if (!done && c) throw new OpenwopError('conflict', 'A deal claim kept changing during erasure; retry the erasure.', 409, {});
  }
}

/**
 * ADR 1034 D8 (grade-code improvement) — a claim whose statement is GONE is not reached by
 * `repointClaims` (that is driven from statement rows), and its `statementId` embeds the
 * rep (`planId:subjectId:period`). Rewrite the subject segment of any claim naming an
 * erased subject, so no claim keeps the id.
 */
export async function eraseClaimSubjects(tenantId: string, forms: ReadonlySet<string>, erasedRef: string): Promise<void> {
  for (const c of await claims.listForTenantIndexed(tenantId)) {
    if (c.tenantId !== tenantId || !c.statementId.startsWith(`${c.planId}:`)) continue;
    const rest = c.statementId.slice(c.planId.length + 1);
    const cut = rest.lastIndexOf(':');
    if (cut <= 0 || !forms.has(rest.slice(0, cut))) continue;
    await claims.compareAndSwap(c, { ...c, statementId: `${c.planId}:${erasedRef}:${rest.slice(cut + 1)}` });
  }
}

/** Delete a plan's claims (the demo reset; a real plan with claims cannot be deleted). */
export async function deletePlanClaims(tenantId: string, orgId: string, planId: string): Promise<number> {
  let removed = 0;
  for (const c of await listPlanClaims(tenantId, orgId, planId)) if (await claims.compareAndDelete(c)) removed += 1;
  return removed;
}
