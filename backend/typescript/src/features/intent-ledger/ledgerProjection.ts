/**
 * ADR 0136 Phase 1 — the PURE ledger→scope projection + the run.metadata stamp.
 *
 * The ledger projects onto the ADR 0132 `ConversationCapabilityScope` so the existing
 * 0132 resolver + loop enforce it (one enforcement path). The stamp carries the scope
 * CONFIG (resolved against the agent ceiling LIVE in the loop, like the chipset) plus
 * the contract metadata; read verbatim on `:fork` (mirrors computeCapabilityScopeStamp).
 *
 * @see docs/adr/0136-intent-ledger.md
 */
import type { ConversationCapabilityScope } from '../../host/conversationStore.js';
import type { IntentLedger, IntentLedgerStamp } from './types.js';

export const INTENT_LEDGER_KEY = 'intentLedger';

/** Project a ledger onto the per-conversation capability scope (the ADR 0132 type).
 *  allowed→enabled, forbidden→disabled, requireApproval→requireApproval. The 0132
 *  resolver intersects with the agent ceiling (never-widen) when the loop enforces it. */
export function ledgerToScope(ledger: IntentLedger): ConversationCapabilityScope {
  return {
    mode: 'restricted',
    enabled: ledger.allowed,
    disabled: ledger.forbidden,
    requireApproval: ledger.requireApproval,
  };
}

/** Stamp the approved ledger's scope config + contract metadata into run.metadata.
 *  Null when already stamped (the :fork guard) or no active ledger. */
export function computeIntentLedgerStamp(
  metadata: Record<string, unknown>,
  ledger: IntentLedger | null,
  resolvedAt?: string,
): Record<string, unknown> | null {
  if (metadata[INTENT_LEDGER_KEY]) return null; // already stamped (or a fork) — never re-resolve
  if (!ledger || ledger.status !== 'approved') return null; // only an approved ledger governs a run
  const stamp: IntentLedgerStamp = {
    conversationId: ledger.conversationId,
    scope: ledgerToScope(ledger),
    goal: ledger.goal,
    successCriteria: ledger.successCriteria,
    ...(ledger.expiresAtRelMs !== undefined ? { expiresAtRelMs: ledger.expiresAtRelMs } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
  };
  return { ...metadata, [INTENT_LEDGER_KEY]: stamp };
}

/** Read a stamped ledger from run metadata (verbatim — the :fork path). */
export function readIntentLedgerStamp(metadata: Record<string, unknown> | undefined): IntentLedgerStamp | null {
  const raw = metadata?.[INTENT_LEDGER_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<IntentLedgerStamp>;
  if (!s.scope || typeof s.scope !== 'object' || typeof s.goal !== 'string') return null;
  return {
    conversationId: typeof s.conversationId === 'string' ? s.conversationId : '',
    scope: s.scope,
    goal: s.goal,
    successCriteria: Array.isArray(s.successCriteria) ? s.successCriteria.filter((x): x is string => typeof x === 'string') : [],
    ...(typeof s.expiresAtRelMs === 'number' ? { expiresAtRelMs: s.expiresAtRelMs } : {}),
    ...(typeof s.resolvedAt === 'string' ? { resolvedAt: s.resolvedAt } : {}),
  };
}
