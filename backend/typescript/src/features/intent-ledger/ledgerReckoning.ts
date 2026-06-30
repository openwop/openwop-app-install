/**
 * ADR 0136 Phase 4 — the PURE authored-vs-completed reckoning.
 *
 * Reconciles the stamped mission contract against what the run actually did: which
 * authorized tools were used, which gate-blocked attempts occurred, and the success
 * criteria still to verify. It is an honest EVIDENCE SUMMARY, not a verdict — success
 * criteria are prose marked `needs-review` (an LLM/human judge is a deferred follow-on).
 * Read-only projection over recorded tool events; no new store.
 *
 * @see docs/adr/0136-intent-ledger.md
 */
import type { IntentLedgerStamp } from './types.js';

export interface ToolEvent { name: string; status: string }

export interface LedgerReckoning {
  goal: string;
  successCriteria: { text: string; status: 'needs-review' }[];
  authorizedTools: string[];
  gatedTools: string[];
  /** Distinct tools the run actually executed (toolReturned status 'ok'). */
  usedTools: string[];
  /** Tools the run attempted but a gate blocked (status 'forbidden') — counts ALL gate
   *  types (§A14 allowlist / ADR 0102 perms / ADR 0135 firewall / scope+ledger), so it
   *  is an out-of-mandate PROXY, not a ledger-only attribution. */
  blockedToolAttempts: string[];
  /** True when the run made no gate-blocked attempts (a proxy for staying in mandate). */
  withinMandate: boolean;
}

const distinct = (xs: string[]): string[] => [...new Set(xs)];

export function reckonLedger(stamp: IntentLedgerStamp, toolEvents: readonly ToolEvent[]): LedgerReckoning {
  const used = distinct(toolEvents.filter((e) => e.status === 'ok').map((e) => e.name));
  const blocked = distinct(toolEvents.filter((e) => e.status === 'forbidden').map((e) => e.name));
  return {
    goal: stamp.goal,
    successCriteria: stamp.successCriteria.map((text) => ({ text, status: 'needs-review' as const })),
    authorizedTools: stamp.scope.enabled ?? [],
    gatedTools: stamp.scope.requireApproval ?? [],
    usedTools: used,
    blockedToolAttempts: blocked,
    withinMandate: blocked.length === 0,
  };
}
