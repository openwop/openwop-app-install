/**
 * ADR 0136 Phase 1 — the PURE ledger→scope projection + the run.metadata stamps.
 *
 * The ledger projects onto the ADR 0132 `ConversationCapabilityScope` so the existing
 * 0132 resolver + loop enforce it (one enforcement path). The gate reads the LIVE
 * ledger every turn; the stamps are provenance plus the run's TTL anchor, the one
 * thing replayed from them on `:fork`.
 *
 * ADR 0896 D4 — one stamp per APPROVAL (`run.metadata.intentLedgerApprovals`, keyed
 * `${ledgerId}@${approvedAt}`), append-only. A chat run spans its whole conversation,
 * so the old single stamp, written once, anchored every later mission's TTL at the
 * first mission's start.
 *
 * @see docs/adr/0136-intent-ledger.md
 * @see docs/adr/0896-intent-ledger-approval-authority.md
 */
import type { ConversationCapabilityScope } from '../../host/conversationStore.js';
import type { IntentLedger, IntentLedgerStamp } from './types.js';

/** The legacy single stamp (read only — ADR 0896 D4). */
export const INTENT_LEDGER_KEY = 'intentLedger';
/** ADR 0896 D4 — the per-approval stamps. Reserved run metadata (D3). */
export const INTENT_LEDGER_APPROVALS_KEY = 'intentLedgerApprovals';

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

/** The key one approval's stamp is filed under. A legacy approved row (no
 *  `approvedAt`) keys on `legacy`. */
export function approvalKeyOf(ledger: Pick<IntentLedger, 'ledgerId' | 'approvedAt'>): string {
  return `${ledger.ledgerId}@${ledger.approvedAt ?? 'legacy'}`;
}

function parseStamp(raw: unknown): IntentLedgerStamp | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<IntentLedgerStamp>;
  if (!s.scope || typeof s.scope !== 'object' || typeof s.goal !== 'string') return null;
  return {
    ...(typeof s.ledgerId === 'string' ? { ledgerId: s.ledgerId } : {}),
    ...(typeof s.approvedAt === 'string' ? { approvedAt: s.approvedAt } : {}),
    ...(typeof s.runId === 'string' ? { runId: s.runId } : {}),
    conversationId: typeof s.conversationId === 'string' ? s.conversationId : '',
    scope: s.scope,
    goal: s.goal,
    successCriteria: Array.isArray(s.successCriteria) ? s.successCriteria.filter((x): x is string => typeof x === 'string') : [],
    ...(typeof s.expiresAtRelMs === 'number' ? { expiresAtRelMs: s.expiresAtRelMs } : {}),
    ...(typeof s.resolvedAt === 'string' ? { resolvedAt: s.resolvedAt } : {}),
  };
}

/** Read the legacy single stamp from run metadata (verbatim). */
export function readIntentLedgerStamp(metadata: Record<string, unknown> | undefined): IntentLedgerStamp | null {
  return parseStamp(metadata?.[INTENT_LEDGER_KEY]);
}

/** ADR 0896 D4 — this run's stamp for THIS approval, or null. A legacy approved row
 *  matches a legacy single stamp on the same conversation (the pre-0896 anchor is
 *  kept rather than restarted). */
export function readApprovalStamp(metadata: Record<string, unknown> | undefined, ledger: IntentLedger): IntentLedgerStamp | null {
  const map = metadata?.[INTENT_LEDGER_APPROVALS_KEY];
  if (map && typeof map === 'object') {
    const hit = parseStamp((map as Record<string, unknown>)[approvalKeyOf(ledger)]);
    if (hit && hit.ledgerId === ledger.ledgerId) return hit;
  }
  if (ledger.approvedAt === undefined) {
    const legacy = readIntentLedgerStamp(metadata);
    if (legacy && legacy.ledgerId === undefined && legacy.conversationId === ledger.conversationId) return legacy;
  }
  return null;
}

/** ADR 0896 D4 — add this approval's stamp to the run's metadata when it has none.
 *  Never rewrites an existing entry (a `:fork` re-reads the recorded anchor). Null when
 *  nothing changes or the ledger is not approved. */
export function withApprovalStamp(
  metadata: Record<string, unknown>,
  ledger: IntentLedger | null,
  resolvedAt: string,
  runId?: string,
): Record<string, unknown> | null {
  if (!ledger || ledger.status !== 'approved') return null;
  if (readApprovalStamp(metadata, ledger)) return null;
  const prior = metadata[INTENT_LEDGER_APPROVALS_KEY];
  const map = prior && typeof prior === 'object' ? (prior as Record<string, unknown>) : {};
  const stamp: IntentLedgerStamp = {
    ledgerId: ledger.ledgerId,
    ...(ledger.approvedAt ? { approvedAt: ledger.approvedAt } : {}),
    ...(runId ? { runId } : {}),
    conversationId: ledger.conversationId,
    scope: ledgerToScope(ledger),
    goal: ledger.goal,
    successCriteria: ledger.successCriteria,
    ...(ledger.expiresAtRelMs !== undefined ? { expiresAtRelMs: ledger.expiresAtRelMs } : {}),
    resolvedAt,
  };
  return { ...metadata, [INTENT_LEDGER_APPROVALS_KEY]: { ...map, [approvalKeyOf(ledger)]: stamp } };
}
