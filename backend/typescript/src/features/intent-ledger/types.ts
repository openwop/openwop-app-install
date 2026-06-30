/**
 * ADR 0136 — Intent Ledger types.
 *
 * A reviewable pre-flight mission contract. Its `allowed`/`forbidden`/`requireApproval`
 * PROJECT onto the ADR 0132 `ConversationCapabilityScope` (enforcement reused, not
 * rebuilt); the ledger adds the contract metadata — goal, success criteria, and a
 * relative-TTL expiry — plus the authored-vs-completed reckoning (P4).
 *
 * @see docs/adr/0136-intent-ledger.md
 */

export type IntentLedgerStatus = 'draft' | 'approved' | 'expired' | 'rejected';

export interface IntentLedger {
  ledgerId: string;
  tenantId: string;
  conversationId: string;
  goal: string;
  /** Tool ids/prefixes the mission may use (→ ADR 0132 `enabled`). */
  allowed: string[];
  /** Tool ids/prefixes the mission may NOT use (→ ADR 0132 `disabled`). */
  forbidden: string[];
  /** Tool ids/prefixes that need per-call approval (→ ADR 0132 `requireApproval`). */
  requireApproval: string[];
  /** Human success criteria, checked at run end (P4). */
  successCriteria: string[];
  /** TTL from run start in ms — a RELATIVE expiry so `:fork` is deterministic (no
   *  wall-clock at replay). Absent ⇒ no expiry. */
  expiresAtRelMs?: number;
  status: IntentLedgerStatus;
  proposedBy: 'extractor' | 'user';
  approvedBy?: string;
  createdAt: string;
}

/** The shape stamped into `run.metadata.intentLedger` — the scope CONFIG (resolved
 *  against the agent ceiling LIVE in the loop, like the chipset config) + the contract
 *  metadata. Read verbatim on `:fork`. */
export interface IntentLedgerStamp {
  /** The conversation this mission governs — carried so the P4 reckoning can find a
   *  run's mission without relying on metadata.chatSessionId being set. */
  conversationId: string;
  scope: { mode: 'agent-default' | 'restricted'; enabled?: string[]; disabled?: string[]; requireApproval?: string[] };
  goal: string;
  successCriteria: string[];
  expiresAtRelMs?: number;
  resolvedAt?: string;
}
