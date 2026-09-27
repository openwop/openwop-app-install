/**
 * Assistant health snapshot (ADR 0029 Part 1 / ADR 0023 §12 T8) — the
 * operating metrics that tell an admin whether the assistant is USEFUL and
 * SAFE to widen: product quality (approval/edit/rejection rates, citation
 * coverage, stale items) + operational state (loop status, connector health).
 *
 * One batched read; counters computed on existing seams — no metrics
 * pipeline, no second store. Host-specific names stay in the host vendor
 * namespace (`observability.md`/`host-extensions.md`); nothing claims
 * `openwop.*`.
 */

import { listCommitments, listPendingActions } from './assistantService.js';
import { listLoopStatuses, type AssistantLoopStatus } from './loops.js';
// NOTE: connector health (active / needs-reconsent counts) deliberately does
// NOT appear here — that would be a cross-feature import (assistant →
// connections, ADR 0001); the Connections page + its /test probe own it.

export interface AssistantHealth {
  generatedAt: string;
  actions: {
    pending: number;
    approved: number;
    rejected: number;
    sent: number;
    failed: number;
    /**
     * COS-8 — actions allowed under a NON-`approval-required` policy
     * (`draft-only`): the human decision is recorded but the policy blocked
     * egress, so nothing was sent. Counted separately and EXCLUDED from the
     * human-oversight metrics below (it is neither a human accept nor a human
     * decision — the approval gate was a no-op under that policy).
     */
    suppressed: number;
    /** approved+sent / decided — how often the assistant's drafts are accepted.
     *  Human oversight only: policy-`suppressed` actions are excluded from both
     *  the numerator (accepted) and the denominator (decided) — see COS-8. */
    approvalRate: number | null;
    /** Fraction of decided actions the principal edited first. */
    editRate: number | null;
    /** Fraction of actions citing ≥1 resolvable source. */
    citationCoverage: number | null;
    taintedShare: number | null;
  };
  commitments: {
    open: number;
    /** Open past their dueAt — the assistant is surfacing but not closing. */
    stale: number;
    citationCoverage: number | null;
  };
  loops: AssistantLoopStatus[];
}

const rate = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 100) / 100 : null);

export async function buildAssistantHealth(tenantId: string, nowMs: number = Date.now()): Promise<AssistantHealth> {
  const [open, allActions, loops] = await Promise.all([
    listCommitments(tenantId, { status: 'open' }),
    listPendingActions(tenantId),
    listLoopStatuses(tenantId),
  ]);

  const byStatus = (s: string): number => allActions.filter((a) => a.status === s).length;
  // COS-8 — `decided` is HUMAN oversight decisions only. `pending` has no
  // decision yet; `suppressed` was allowed by a non-`approval-required` policy,
  // where the human approval gate was a no-op — counting it would let a lenient
  // policy inflate the oversight numbers. Excluded from BOTH numerator and
  // denominator (out of `decided` ⇒ out of `accepted`, which filters `decided`).
  const decided = allActions.filter((a) => a.status !== 'pending' && a.status !== 'suppressed');
  const accepted = decided.filter((a) => a.status === 'approved' || a.status === 'sent');
  const cited = allActions.filter((a) => (a.sourceRefs ?? []).length > 0);
  const stale = open.filter((c) => {
    if (!c.dueAt) return false;
    const due = Date.parse(c.dueAt);
    return Number.isFinite(due) && due < nowMs;
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    actions: {
      pending: byStatus('pending'),
      approved: byStatus('approved'),
      rejected: byStatus('rejected'),
      sent: byStatus('sent'),
      failed: byStatus('failed'),
      suppressed: byStatus('suppressed'),
      approvalRate: rate(accepted.length, decided.length),
      editRate: rate(decided.filter((a) => a.editedAt !== undefined).length, decided.length),
      citationCoverage: rate(cited.length, allActions.length),
      taintedShare: rate(allActions.filter((a) => a.derivedFromUntrusted === true).length, allActions.length),
    },
    commitments: {
      open: open.length,
      stale: stale.length,
      citationCoverage: rate(open.filter((c) => c.source.url !== undefined || c.source.kbDocumentId !== undefined).length, open.length),
    },
    loops,
  };
}
