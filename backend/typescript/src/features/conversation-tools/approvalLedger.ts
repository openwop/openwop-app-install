/**
 * ADR 0132 Phase 3 — the per-conversation tool-approval ledger.
 *
 * The in-process tool loop cannot suspend mid-iteration, so a held tool call is not
 * executed; it is recorded here as `pending`, the chat surfaces it (ADR 0834 D6 —
 * the pending-approval notice above the composer; there is NO `interrupt.approval`
 * card for chat tool calls, whatever ADR 0150 said), and a human with authority over
 * the conversation resolves it to `approved` / `denied`. On the agent's RE-ATTEMPT the
 * loop folds the resolved decision into the effective scope (`applyApprovalDecisions`)
 * and into the firewall's approved sets: approved ⇒ the tool executes; denied ⇒ it is
 * forbidden.
 *
 * Keyed by (tenantId, conversationId, toolName) — the grain is per-tool-for-this-
 * conversation: an approval covers every later call of that tool in the conversation,
 * with whatever arguments the agent uses then (allow-once is ADR 0834 FW2-D1).
 *
 * ADR 0834 D2 — every row records the ORIGIN of the ask that raised it. A `baseline`
 * row (a user-level ask: the safe-mode baseline, or the owner's own ADR 0132 scope)
 * satisfies only user-level asks; a `policy` row (a tenant rule, the enforce default,
 * the platform floor) satisfies both. A
 * later `policy` ask on a tool approved only for `baseline` RE-OPENS the row — the one
 * transition that may reset a decision. An approval answers an ask: `resolveToolApproval`
 * refuses a tool with no `pending` row, so nothing can be approved in advance.
 *
 * @see docs/adr/0132-per-conversation-capability-scope.md
 * @see docs/adr/0834-capability-firewall-exit-decision.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { scrubSecretShaped } from '../../host/redactSecrets.js';
import { ERASED, subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import type { ApprovalOrigin } from '../capability-firewall/types.js';

export type ToolApprovalStatus = 'pending' | 'approved' | 'denied';

export interface ToolApprovalRecord {
  tenantId: string;
  conversationId: string;
  toolName: string;
  status: ToolApprovalStatus;
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  /** ADR 0834 D2 — the highest origin that held the tool while pending. Absent on rows
   *  written before ADR 0834; read as `baseline` (an old approval never satisfies a
   *  policy ask it was not shown). */
  origin?: ApprovalOrigin;
  /** ADR 0834 D6 — the latest held call's arguments (secret-scrubbed, capped), shown to
   *  the approver. Updated while `pending`; CLEARED on decision, so it lives no longer
   *  than the ask. */
  requestedInput?: string;
}

/** Cap on the stored arguments (ADR 0834 D6) — enough to show what was asked, bounded. */
export const REQUESTED_INPUT_MAX_CHARS = 2048;

const ledger = new DurableCollection<ToolApprovalRecord>(
  'conversation-tools:approval',
  (r) => `${r.tenantId}:${r.conversationId}:${r.toolName}`,
);

const key = (tenantId: string, conversationId: string, toolName: string): string =>
  `${tenantId}:${conversationId}:${toolName}`;

const now = (): string => new Date().toISOString();

const withoutInput = (r: ToolApprovalRecord): ToolApprovalRecord => {
  const out = { ...r };
  delete out.requestedInput;
  return out;
};

/** Bound on compare-and-swap retries for a re-ask (contention is two writers on one row). */
const CAS_ATTEMPTS = 5;

const rank = (o: ApprovalOrigin | undefined): number => (o === 'policy' ? 1 : 0);

/** Serialize + scrub + cap a held call's arguments for display. */
export function summarizeRequestedInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input || Object.keys(input).length === 0) return undefined;
  let text: string;
  try { text = JSON.stringify(input); } catch { return undefined; }
  text = scrubSecretShaped(text);
  return text.length > REQUESTED_INPUT_MAX_CHARS ? `${text.slice(0, REQUESTED_INPUT_MAX_CHARS)}…` : text;
}

/** Record that a tool call is awaiting approval.
 *  - no row ⇒ a `pending` row;
 *  - `pending` ⇒ arguments + `requestedAt` refreshed, origin raised (never lowered);
 *  - `approved` for a LOWER origin than this ask ⇒ re-opened as `pending` (escalation);
 *  - otherwise (approved for this origin, or denied) ⇒ kept verbatim.
 *  Every write is a compare-and-swap against the row it read (FW2-CD-2), retried a
 *  bounded number of times, so a concurrent approve cannot be overwritten by a stale
 *  re-ask and two first asks cannot lose an escalation. */
export async function recordToolApprovalRequested(
  tenantId: string,
  conversationId: string,
  toolName: string,
  ask: { origin?: ApprovalOrigin; input?: Record<string, unknown> } = {},
): Promise<void> {
  const origin: ApprovalOrigin = ask.origin ?? 'baseline';
  const requestedInput = summarizeRequestedInput(ask.input);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const existing = await ledger.get(key(tenantId, conversationId, toolName));
    const fresh = (): ToolApprovalRecord => ({
      tenantId, conversationId, toolName, status: 'pending', requestedAt: now(), origin,
      ...(requestedInput ? { requestedInput } : {}),
    });
    let next: ToolApprovalRecord | null;
    if (!existing) next = fresh();
    else if (existing.status === 'pending') {
      const raised: ApprovalOrigin = rank(existing.origin) >= rank(origin) ? (existing.origin ?? 'baseline') : origin;
      next = { ...withoutInput(existing), origin: raised, requestedAt: now(), ...(requestedInput ? { requestedInput } : {}) };
    } else if (existing.status === 'approved' && rank(existing.origin) < rank(origin)) next = fresh();
    else next = null; // approved for this origin (or higher), or denied — keep the decision verbatim.
    if (next === null) return;
    if (await ledger.compareAndSwap(existing, next)) return;
  }
  throw new Error(`approval ledger contention: ${toolName}`);
}

export type ResolveToolApprovalResult =
  | { ok: true; record: ToolApprovalRecord }
  | { ok: false; reason: 'no_pending_approval' | 'approval_changed' };

/** Resolve a PENDING tool approval (the route calls this). Refuses a tool with no
 *  pending row (an approval answers an ask; it cannot be issued in advance), and — when
 *  the caller names the `requestedAt` it displayed — a row that moved since. The write is
 *  a compare-and-swap against the row read, so a re-ask that lands between the read and
 *  the write is refused (`approval_changed`), never silently approved. Clears the
 *  stored arguments. */
export async function resolveToolApproval(
  tenantId: string,
  conversationId: string,
  toolName: string,
  decision: 'approved' | 'denied',
  resolvedBy: string,
  expectedRequestedAt?: string,
): Promise<ResolveToolApprovalResult> {
  const existing = await ledger.get(key(tenantId, conversationId, toolName));
  if (!existing || existing.status !== 'pending') return { ok: false, reason: 'no_pending_approval' };
  if (expectedRequestedAt !== undefined && existing.requestedAt !== expectedRequestedAt) return { ok: false, reason: 'approval_changed' };
  const updated: ToolApprovalRecord = { ...withoutInput(existing), status: decision, resolvedAt: now(), resolvedBy };
  if (!(await ledger.compareAndSwap(existing, updated))) return { ok: false, reason: 'approval_changed' };
  return { ok: true, record: updated };
}

/** All approval records for a conversation (the fold source + the FE list). */
export async function listToolApprovals(tenantId: string, conversationId: string): Promise<ToolApprovalRecord[]> {
  return ledger.listByPrefix(`${tenantId}:${conversationId}:`);
}

/** ADR 0834 D2 — split a conversation's approved rows by the origin they answered:
 *  `policy` rows satisfy any ask; `baseline` (and legacy origin-less) rows satisfy only
 *  the user's own safe-mode ask. */
export function approvedToolSets(approvals: readonly ToolApprovalRecord[]): { approvedTools: Set<string>; approvedBaselineTools: Set<string> } {
  const approvedTools = new Set<string>();
  const approvedBaselineTools = new Set<string>();
  for (const a of approvals) {
    if (a.status !== 'approved') continue;
    (a.origin === 'policy' ? approvedTools : approvedBaselineTools).add(a.toolName);
  }
  return { approvedTools, approvedBaselineTools };
}

/** ADR 0834 D6 — the conversation was deleted: its approvals mean nothing. Idempotent. */
export async function deleteToolApprovalsForConversation(tenantId: string, conversationId: string): Promise<void> {
  for (const r of await listToolApprovals(tenantId, conversationId)) {
    await ledger.delete(key(r.tenantId, r.conversationId, r.toolName));
  }
}

/** ADR 0834 D6 — the DSAR eraser. `resolvedBy` names the approver; it is redacted, the
 *  decision kept (it is what the next turn folds). A still-`pending` row's arguments
 *  cannot be mapped to a subject (a conversation id is not a subject key — the intent
 *  ledger's stated residual), so they live until decided or the conversation is deleted. */
export async function eraseConversationToolApprovalsSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const forms = subjectKeyForms(subjectKey).forms;
  for (const r of await ledger.listByPrefix(`${tenantId}:`)) {
    if (r.tenantId !== tenantId) continue;
    if (r.resolvedBy === undefined || !forms.has(r.resolvedBy)) continue;
    // CAS: a concurrent decision on this row wins; the eraser re-runs on the next DSAR.
    await ledger.compareAndSwap(r, { ...r, resolvedBy: ERASED });
  }
}

/** Registered from the feature's boot path by MODULE-LEVEL reference (the registry
 *  dedupes by reference). */
export function registerConversationToolApprovalsErasure(): void {
  registerSubjectEraser(eraseConversationToolApprovalsSubject);
}
