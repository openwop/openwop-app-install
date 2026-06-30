/**
 * ADR 0132 — per-conversation capability scope (the `conversation-tools` feature).
 *
 * The persisted CONFIG shape (`ConversationCapabilityScope`) is core-owned (it is a
 * typed field on `ConversationMeta`); this module owns the RESOLVED EFFECTIVE shape
 * + the resolver/stamp logic. The effective set is what the live tool loop enforces
 * (Phase 2) and what is stamped per-run in `run.metadata.capabilityScope` and read
 * verbatim on `:fork` (the ADR 0031 replay invariant).
 *
 * @see docs/adr/0132-per-conversation-capability-scope.md
 */

/** The RESOLVED effective scope for one run — concrete tool ids drawn from the
 *  agent's ceiling at resolution time (so the stamp is a frozen, ceiling-bounded
 *  snapshot). `enabled` is the set the agent may call this conversation;
 *  `requireApproval ⊆ enabled` are the ones that suspend for per-call approval. */
export interface EffectiveScope {
  enabled: string[];
  requireApproval: string[];
}

/** The shape stamped into `run.metadata.capabilityScope` — the effective set plus
 *  provenance for audit/debug. Read verbatim on `:fork`. */
export interface CapabilityScopeStamp extends EffectiveScope {
  resolvedAt?: string;
}
