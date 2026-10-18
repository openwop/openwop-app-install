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
  /** ADR 0896 D1 — when the CURRENT approval was given; part of the approval's key
   *  (`${ledgerId}@${approvedAt}`) a run's TTL anchor is filed under. Cleared on redraft. */
  approvedAt?: string;
  /** IL2CD-5 — who revoked or rejected it, and when (the audit a reject used to lack;
   *  on an ownerless conversation that may be any workspace admin). Erased on DSAR. */
  rejectedBy?: string;
  rejectedAt?: string;
  /** ADR 0896 D1 — bumped by every write; a decision names the revision it reviewed.
   *  Absent on rows written before ADR 0896 (read as 0). */
  revision?: number;
  /** ADR 0896 D7b — the last write; the retention age (falls back to `createdAt`). */
  updatedAt?: string;
  createdAt: string;
}

/** The provenance stamp of one approval on a run — the scope CONFIG + the contract
 *  metadata + the run's TTL anchor (`resolvedAt`). ADR 0896 D4: one per APPROVAL, in
 *  the append-only `run.metadata.intentLedgerApprovals` map (a chat run spans the whole
 *  conversation, so one stamp per run would anchor every later mission at the first).
 *  Enforcement never reads it — the gate reads the live ledger every turn; only the TTL
 *  anchor is replayed from it on `:fork`. The single legacy `run.metadata.intentLedger`
 *  key (no `ledgerId`) is read, never written. */
export interface IntentLedgerStamp {
  /** ADR 0896 D4 — the approval this stamp belongs to. Absent on a legacy stamp. */
  ledgerId?: string;
  approvedAt?: string;
  /** ADR 0896 D5 — the run whose turn minted this entry. A `:fork` copies the entry
   *  (so it re-reads the same anchor) but is a different run, so it never persists
   *  expiry onto the live ledger. */
  runId?: string;
  /** The conversation this mission governs — carried so the P4 reckoning can find a
   *  run's mission without relying on metadata.chatSessionId being set. */
  conversationId: string;
  scope: { mode: 'agent-default' | 'restricted'; enabled?: string[]; disabled?: string[]; requireApproval?: string[] };
  goal: string;
  successCriteria: string[];
  expiresAtRelMs?: number;
  resolvedAt?: string;
}
