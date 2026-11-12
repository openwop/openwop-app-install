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
 * Keyed by (tenantId, conversationId, toolName). ADR 0834 FW2-D1 (CHAN-F2, corrected
 * 2026-11-10) — an approval has a GRAIN, chosen by the approver:
 *  - `call` (the default, and the only grain on a channel lane): it covers ONE call
 *    whose arguments are exactly the ones shown — the row carries an HMAC digest of the
 *    held call's full canonical input (`inputDigest`), and is spent by the call it lets
 *    through. A re-ask with different arguments re-opens it as `pending`.
 *  - `conversation` (in-app only, an explicit second choice): the old per-tool grain —
 *    every later call of that tool in the conversation, any arguments.
 * A row approved before grains existed (no `grain`) is read as `conversation` in-app
 * (what its approver was told) and as unusable on a channel lane (fails closed: re-ask).
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
import { createHmac } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { canonicalize } from '../../host/canonicalJson.js';
import { readSessionSecret } from '../../middleware/cookieSession.js';
import { scrubSecretShaped } from '../../host/redactSecrets.js';
import { ERASED, subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import type { ApprovalOrigin } from '../capability-firewall/types.js';

export type ToolApprovalStatus = 'pending' | 'approved' | 'denied';
/** ADR 0834 FW2-D1 — what an approval covers (see the module header). */
export type ToolApprovalGrain = 'call' | 'conversation';
/** Which lane raised the ask: a channel turn (an outside message) or the app. */
export type ToolApprovalLane = 'app' | 'channel';

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
  /** FW2-D1 — HMAC-SHA256 of the held call's FULL canonical input (never the scrubbed,
   *  capped display copy). Refreshed with `requestedInput` while pending; KEPT on decision,
   *  because a `call`-grain approval is checked against it. */
  inputDigest?: string;
  /** The approver did not see every argument as the call carries it: the display copy was
   *  cut at {@link REQUESTED_INPUT_MAX_CHARS}, or a secret-shaped value was masked. The UI
   *  says so before anyone approves. */
  inputTruncated?: boolean;
  /** Set on approval (FW2-D1). Absent on rows approved before grains existed. */
  grain?: ToolApprovalGrain;
  /** The lane of the latest ask. `channel` ⇒ only the `call` grain may be chosen. */
  lane?: ToolApprovalLane;
}

/** Cap on the stored arguments (ADR 0834 D6) — enough to show what was asked, bounded. */
export const REQUESTED_INPUT_MAX_CHARS = 2048;

/** CHAN-F17 — how long a PENDING ask from a messaging channel can still be approved,
 *  counted from its latest ask (a re-ask renews it). An outside sender's request should
 *  not stay approvable for days: the call it lets through runs on that sender's next
 *  message. `OPENWOP_CHANNEL_APPROVAL_TTL_MIN` overrides; default 24 hours. In-app asks
 *  do not expire (the owner is the one waiting). */
export const CHANNEL_ASK_TTL_DEFAULT_MIN = 24 * 60;
function channelAskTtlMs(): number {
  const raw = Number(process.env.OPENWOP_CHANNEL_APPROVAL_TTL_MIN);
  return (Number.isFinite(raw) && raw > 0 ? raw : CHANNEL_ASK_TTL_DEFAULT_MIN) * 60_000;
}

/** CHAN-F17 — when a channel row stops counting; undefined for every other row:
 *  - a PENDING channel ask stops being approvable TTL after its latest ask;
 *  - an APPROVED, not-yet-used one-call channel approval stops letting its call through
 *    TTL after it was given (the same "outside sender, days later" exposure).
 *  An unreadable timestamp reads as already expired (fails closed). */
export function approvalExpiresAt(r: ToolApprovalRecord): string | undefined {
  if (r.lane !== 'channel') return undefined;
  let from: string | undefined;
  if (r.status === 'pending') from = r.requestedAt;
  // A channel ask can only be approved for one call (`grain_not_allowed`), so every
  // approved channel row is a one-call approval.
  else if (r.status === 'approved') from = r.resolvedAt ?? '';
  else return undefined;
  const at = Date.parse(from);
  return new Date(Number.isFinite(at) ? at + channelAskTtlMs() : 0).toISOString();
}

function isExpired(r: ToolApprovalRecord, nowMs: number = Date.now()): boolean {
  const exp = approvalExpiresAt(r);
  return exp !== undefined && Date.parse(exp) <= nowMs;
}
const isExpiredAsk = (r: ToolApprovalRecord): boolean => r.status === 'pending' && isExpired(r);

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

/** FW2-D1 — the digest an approval is bound to. Keyed (HMAC with the session secret), not
 *  a bare hash: the input is UNSCRUBBED, so a plain SHA-256 at rest would let anyone who
 *  reads the ledger test guesses of a low-entropy secret argument. Canonical JSON (keys
 *  sorted, arrays in order), so a re-attempt that only reorders keys still matches. A
 *  session-secret rotation changes every digest: a pending approval is re-asked once. */
export function toolInputDigest(input: Record<string, unknown> | undefined): string {
  return createHmac('sha256', readSessionSecret()).update(`toolapproval:v1:${canonicalize(input ?? {})}`).digest('base64url');
}

/** The display copy of a held call's arguments, and whether the approver sees all of
 *  them: false when the copy was cut at the cap, when a secret-shaped value was masked
 *  (the approver sees a placeholder, not the value the call carries), or when the input
 *  could not be serialized at all. */
function displayInput(input: Record<string, unknown> | undefined): { text?: string; complete: boolean } {
  if (!input || Object.keys(input).length === 0) return { complete: true };
  let raw: string;
  try { raw = JSON.stringify(input); } catch { return { complete: false }; }
  const text = scrubSecretShaped(raw);
  if (text.length > REQUESTED_INPUT_MAX_CHARS) return { text: `${text.slice(0, REQUESTED_INPUT_MAX_CHARS)}…`, complete: false };
  return { text, complete: text === raw };
}

/** Serialize + scrub + cap a held call's arguments for display. */
export function summarizeRequestedInput(input: Record<string, unknown> | undefined): string | undefined {
  return displayInput(input).text;
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
  ask: { origin?: ApprovalOrigin; input?: Record<string, unknown>; lane?: ToolApprovalLane } = {},
): Promise<void> {
  const origin: ApprovalOrigin = ask.origin ?? 'baseline';
  const display = displayInput(ask.input);
  const shown = {
    inputDigest: toolInputDigest(ask.input),
    ...(display.text ? { requestedInput: display.text } : {}),
    ...(display.complete ? {} : { inputTruncated: true }),
    lane: ask.lane ?? 'app',
  };
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const existing = await ledger.get(key(tenantId, conversationId, toolName));
    const fresh = (): ToolApprovalRecord => ({
      tenantId, conversationId, toolName, status: 'pending', requestedAt: now(), origin, ...shown,
    });
    let next: ToolApprovalRecord | null;
    // CHAN-F17 — an expired ask is gone: the new ask starts over (its origin is not raised
    // by a question nobody can answer any more).
    if (!existing || isExpiredAsk(existing)) next = fresh();
    else if (existing.status === 'pending') {
      const raised: ApprovalOrigin = rank(existing.origin) >= rank(origin) ? (existing.origin ?? 'baseline') : origin;
      const { inputTruncated: _t, inputDigest: _d, lane: _l, ...rest } = withoutInput(existing);
      next = { ...rest, origin: raised, requestedAt: now(), ...shown };
    } else if (existing.status === 'approved' && rank(existing.origin) < rank(origin)) next = fresh();
    // FW2-D1 — a one-call approval covers the arguments it was shown, nothing else: an ask
    // with different arguments is a new question.
    else if (existing.status === 'approved' && existing.grain === 'call' && existing.inputDigest !== shown.inputDigest) next = fresh();
    else next = null; // approved for this origin (or higher), or denied — keep the decision verbatim.
    if (next === null) return;
    if (await ledger.compareAndSwap(existing, next)) return;
  }
  throw new Error(`approval ledger contention: ${toolName}`);
}

export type ResolveToolApprovalResult =
  | { ok: true; record: ToolApprovalRecord }
  | { ok: false; reason: 'no_pending_approval' | 'approval_changed' | 'grain_not_allowed' | 'approval_expired' };

/** Resolve a PENDING tool approval (the route calls this). Refuses a tool with no
 *  pending row (an approval answers an ask; it cannot be issued in advance), and — when
 *  the caller names the `requestedAt` it displayed — a row that moved since. The write is
 *  a compare-and-swap against the row read, so a re-ask that lands between the read and
 *  the write is refused (`approval_changed`), never silently approved. Clears the
 *  displayed arguments; KEEPS `inputDigest` (a `call` approval is checked against it).
 *  FW2-D1: `grain` defaults to `call`; `conversation` is refused for a `channel` ask
 *  (`grain_not_allowed`), and for a row whose arguments were not all shown. */
export async function resolveToolApproval(
  tenantId: string,
  conversationId: string,
  toolName: string,
  decision: 'approved' | 'denied',
  resolvedBy: string,
  expectedRequestedAt?: string,
  grain: ToolApprovalGrain = 'call',
): Promise<ResolveToolApprovalResult> {
  const existing = await ledger.get(key(tenantId, conversationId, toolName));
  if (!existing || existing.status !== 'pending') return { ok: false, reason: 'no_pending_approval' };
  if (expectedRequestedAt !== undefined && existing.requestedAt !== expectedRequestedAt) return { ok: false, reason: 'approval_changed' };
  // CHAN-F17 — an expired channel ask cannot be decided; it is removed (compare-and-delete,
  // so a re-ask that just renewed it survives) and the agent's next attempt asks again.
  if (isExpiredAsk(existing)) {
    await ledger.compareAndDelete(existing).catch(() => false);
    return { ok: false, reason: 'approval_expired' };
  }
  if (decision === 'approved' && grain === 'conversation' && existing.lane === 'channel') return { ok: false, reason: 'grain_not_allowed' };
  const updated: ToolApprovalRecord = {
    ...withoutInput(existing), status: decision, resolvedAt: now(), resolvedBy,
    ...(decision === 'approved' ? { grain } : {}),
  };
  if (!(await ledger.compareAndSwap(existing, updated))) return { ok: false, reason: 'approval_changed' };
  return { ok: true, record: updated };
}

export type RevokeToolApprovalResult = { ok: true } | { ok: false; reason: 'no_approval' | 'approval_changed' };

/** CHAN-F17 — REVOKE an approval the owner gave: the row is removed, so the agent's next
 *  call of the tool is asked about again. Only an `approved` row (any grain: a tool-wide
 *  grant, or a one-call approval not yet used). `expectedResolvedAt` is the version the
 *  owner saw; a row re-decided since is refused (`approval_changed`). Compare-and-delete,
 *  so a concurrent re-ask or spend wins.
 *  Takes effect from the NEXT turn: a turn already running read its approvals when it
 *  started. A channel turn that has CLAIMED the row holds it outside the ledger, so a
 *  revoke during that turn finds nothing (`no_approval`) and the turn may hand an unspent
 *  claim back afterwards; the owner revokes it again then. */
export async function revokeToolApproval(
  tenantId: string,
  conversationId: string,
  toolName: string,
  expectedResolvedAt: string,
): Promise<RevokeToolApprovalResult> {
  const existing = await ledger.get(key(tenantId, conversationId, toolName));
  if (!existing || existing.status !== 'approved') return { ok: false, reason: 'no_approval' };
  if (existing.resolvedAt !== expectedResolvedAt) return { ok: false, reason: 'approval_changed' };
  return (await ledger.compareAndDelete(existing)) ? { ok: true } : { ok: false, reason: 'approval_changed' };
}

/**
 * ADR 1042 CHAN-F3 (security review H2, multi-instance) — CLAIM a channel turn's
 * approvals before the turn runs, instead of spending them after it returns.
 *
 * The approval used to be spent (deleted) once the tool loop had finished. Turns are serialised per
 * thread only within ONE process, so two instances could each start a turn, each
 * read the same `approved` row, and each let one call through: one approval, two
 * calls. Here each approved row is removed with a compare-and-delete BEFORE the loop
 * is built, and only the rows this turn won are folded into its firewall. Two
 * concurrent turns cannot both win one row.
 *
 * Fail-safe by construction: while a channel turn holds a claim, any other turn on
 * the conversation sees no approval and asks the owner again; a crash mid-turn loses
 * the unspent claims (the owner approves again), it never duplicates one.
 * Returns the rows won.
 */
export async function claimApprovedToolApprovals(rows: readonly ToolApprovalRecord[]): Promise<ToolApprovalRecord[]> {
  const won: ToolApprovalRecord[] = [];
  for (const r of rows) {
    if (r.status === 'approved' && (await ledger.compareAndDelete(r))) won.push(r);
  }
  return won;
}

/** CHAN-F3 — hand back the claimed approvals the turn did NOT spend. `putIfAbsent`,
 *  never `put`: a row written meanwhile (a fresh ask, a denial, a re-approval) wins. */
export async function returnUnspentToolApprovals(claimed: readonly ToolApprovalRecord[], spent: ReadonlySet<string>): Promise<void> {
  for (const r of claimed) {
    if (!spent.has(r.toolName)) await ledger.putIfAbsent(r).catch(() => false);
  }
}

/** All approval records for a conversation (the fold source + the FE list). */
export async function listToolApprovals(tenantId: string, conversationId: string): Promise<ToolApprovalRecord[]> {
  return ledger.listByPrefix(`${tenantId}:${conversationId}:`);
}

/** ADR 0834 D2 — split a conversation's approved rows by the origin they answered:
 *  `policy` rows satisfy any ask; `baseline` (and legacy origin-less) rows satisfy only
 *  the user's own safe-mode ask. FW2-D1: only TOOL-WIDE rows (`conversation`, or legacy
 *  grain-less) are in these sets; a `call` row covers one call and is answered only by
 *  {@link makeApprovalGrant}, so a by-name consumer can never widen it. */
export function approvedToolSets(approvals: readonly ToolApprovalRecord[]): { approvedTools: Set<string>; approvedBaselineTools: Set<string> } {
  const approvedTools = new Set<string>();
  const approvedBaselineTools = new Set<string>();
  for (const a of approvals) {
    if (a.status !== 'approved' || a.grain === 'call') continue;
    (a.origin === 'policy' ? approvedTools : approvedBaselineTools).add(a.toolName);
  }
  return { approvedTools, approvedBaselineTools };
}

/** The rows the ADR 0132 scope fold may use: every denial, and — in-app only — the
 *  tool-wide approvals. A `call` approval never widens the scope (the dispatch gate asks
 *  {@link makeApprovalGrant} per call), and on a channel turn NO approval is folded: the
 *  turn's approvals are the rows it CLAIMED, answered per call (the CHAN-F2 fix for the
 *  scope gate folding every row, claimed or not). */
export function scopeFoldRows(approvals: readonly ToolApprovalRecord[], channelTurn: boolean): ToolApprovalRecord[] {
  return approvals.filter((a) => a.status === 'denied' || (!channelTurn && a.status === 'approved' && a.grain !== 'call'));
}

/** FW2-D1 — the per-call answer to "is there an approval for THIS call?", shared by every
 *  gate of a turn (the ADR 0132 scope gate and the firewall) so one approval satisfies
 *  both gates for one call and is spent once.
 *  - a `call` row satisfies only a call whose input digest equals its `inputDigest`, once;
 *  - a tool-wide row (`conversation`, legacy) satisfies any call — unless `requireDigest`
 *    (a channel turn), where it satisfies none (fails closed: the owner is asked again);
 *  - `singleUse` (a channel turn) spends every row on the call it lets through;
 *  - an origin-`policy` ask is satisfied only by a `policy` row (ADR 0834 D2).
 *  Answers are memoised per `callKey`, so two gates asking about one call agree and spend
 *  once. `spent()` lists the rows used up, for the turn's settle step. */
export interface ApprovalGrant {
  check(toolName: string, origin: ApprovalOrigin | undefined, input: Record<string, unknown> | undefined, callKey: string): boolean;
  spent(): ToolApprovalRecord[];
}
export function makeApprovalGrant(rows: readonly ToolApprovalRecord[], opts: { singleUse: boolean; requireDigest: boolean }): ApprovalGrant {
  // CHAN-F17 — an expired one-call channel approval answers nothing (the owner approves again).
  const approved = rows.filter((r) => r.status === 'approved' && !isExpired(r));
  const used = new Set<ToolApprovalRecord>();
  // The row chosen for each call, chosen ONCE, so the scope gate and the firewall asking
  // about the same call agree and spend one row. (The ledger holds one row per tool per
  // conversation, so there is at most one candidate.)
  const chosen = new Map<string, ToolApprovalRecord | null>();
  return {
    check(toolName, origin, input, callKey) {
      const k = `${callKey}\u0000${toolName}`;
      let row = chosen.get(k);
      if (row === undefined) {
        let digest: string | undefined;
        const usable = approved.filter((r) => {
          if (r.toolName !== toolName || used.has(r)) return false;
          if (r.grain === 'call') return r.inputDigest !== undefined && r.inputDigest === (digest ??= toolInputDigest(input));
          return !opts.requireDigest;
        });
        row = usable[0] ?? null;
        if (row && (opts.singleUse || row.grain === 'call')) used.add(row);
        chosen.set(k, row);
      }
      if (row === null) return false;
      return origin !== 'policy' || row.origin === 'policy';
    },
    spent: () => [...used],
  };
}

/** FW2-D1 — after an IN-APP turn: delete the `call` approvals it spent (compare-and-delete,
 *  so a row re-decided meanwhile survives). Channel turns hand unspent claims back instead
 *  ({@link returnUnspentToolApprovals}); their spent rows were removed by the claim. */
export async function deleteSpentCallApprovals(spent: readonly ToolApprovalRecord[]): Promise<void> {
  for (const r of spent) if (r.grain === 'call') await ledger.compareAndDelete(r).catch(() => false);
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
