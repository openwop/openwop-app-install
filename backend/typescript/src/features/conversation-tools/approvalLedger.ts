/**
 * ADR 0132 Phase 3 — the per-conversation tool-approval ledger.
 *
 * The in-process tool loop cannot suspend mid-iteration, so a `requireApproval`
 * tool call is not executed; it is recorded here as `pending`, the conversation
 * surfaces an `interrupt.approval` card, and a human resolves it to `approved` /
 * `denied`. On the agent's RE-ATTEMPT the loop folds the resolved decision into the
 * effective scope (`applyApprovalDecisions`): approved ⇒ the tool executes; denied
 * ⇒ it is forbidden. Decisions are durable + deterministic to read, so replay is
 * stable.
 *
 * Keyed by (tenantId, conversationId, toolName) — the grain is per-tool-for-this-
 * conversation ("Allow this tool for the chat / Deny"), the architecturally-honest
 * fit given the no-mid-loop-suspend constraint (ADR 0132 §Phase 3 correction).
 *
 * @see docs/adr/0132-per-conversation-capability-scope.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';

export type ToolApprovalStatus = 'pending' | 'approved' | 'denied';

export interface ToolApprovalRecord {
  tenantId: string;
  conversationId: string;
  toolName: string;
  status: ToolApprovalStatus;
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

const ledger = new DurableCollection<ToolApprovalRecord>(
  'conversation-tools:approval',
  (r) => `${r.tenantId}:${r.conversationId}:${r.toolName}`,
);

const key = (tenantId: string, conversationId: string, toolName: string): string =>
  `${tenantId}:${conversationId}:${toolName}`;

const now = (): string => new Date().toISOString();

/** Record that a tool call is awaiting approval. Idempotent + decision-preserving:
 *  a no-op if a record already exists (never resets an already-resolved decision
 *  back to `pending`). */
export async function recordToolApprovalRequested(
  tenantId: string,
  conversationId: string,
  toolName: string,
): Promise<void> {
  const existing = await ledger.get(key(tenantId, conversationId, toolName));
  if (existing) return; // keep an existing pending/approved/denied record verbatim
  await ledger.put({ tenantId, conversationId, toolName, status: 'pending', requestedAt: now() });
}

/** Resolve a pending tool approval (the Phase 4 route calls this). Records the
 *  decision + who/when. Returns the updated record, or null if none was pending. */
export async function resolveToolApproval(
  tenantId: string,
  conversationId: string,
  toolName: string,
  decision: 'approved' | 'denied',
  resolvedBy: string,
): Promise<ToolApprovalRecord | null> {
  const existing = await ledger.get(key(tenantId, conversationId, toolName));
  const base: ToolApprovalRecord = existing ?? { tenantId, conversationId, toolName, status: 'pending', requestedAt: now() };
  const updated: ToolApprovalRecord = { ...base, status: decision, resolvedAt: now(), resolvedBy };
  await ledger.put(updated);
  return updated;
}

/** All approval records for a conversation (the fold source + the FE list). */
export async function listToolApprovals(tenantId: string, conversationId: string): Promise<ToolApprovalRecord[]> {
  return ledger.listByPrefix(`${tenantId}:${conversationId}:`);
}
