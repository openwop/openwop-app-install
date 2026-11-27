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
import { registerDefaultWindowSweep, type PurgeOutcome } from '../../host/retentionPurger.js';
import { getRetentionHold } from '../../host/retentionHold.js';
import { isKmsConfigured, kmsDecrypt, kmsEncrypt, type KmsAadContext, type KmsEncryptedRecord } from '../../byok/kmsEncryption.js';
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
  /** ADR 1156 D2 — the wire message id of the agent turn whose call raised the latest
   *  ask: the chat card for that turn is this row. Refreshed with each ask. */
  askId?: string;
  /** ADR 1156 D3 — the tool's own plain description of the held call (`describeApproval`),
   *  scrubbed and capped. Lives exactly as long as `requestedInput`: cleared on decision. */
  requestedLines?: ApprovalLine[];
  /** ADR 1156 P2 (D10) — the held call's FULL input, sealed (the KMS envelope, AAD bound to
   *  this row and its `inputDigest`), so the continue turn can run exactly the call that was
   *  approved. In-app asks only. Kept while pending and on a `call`-grain approval; dropped on
   *  every other decision, and gone with the row when the call is run or the conversation is
   *  deleted. Never returned by the routes. */
  sealedInput?: string;
}

/** ADR 1156 D3 — one line of a tool's description of a held call. `group` lets a tool
 *  gather lines under a heading (one frame of a board, one record). */
export interface ApprovalLine { text: string; group?: string }

/** ADR 1156 D3 — caps on a tool's description: enough for a change of dozens of lines. */
export const REQUESTED_LINES_MAX = 200;
export const REQUESTED_LINE_MAX_CHARS = 600;
const REQUESTED_GROUP_MAX_CHARS = 120;

/** Scrub and cap a tool's description of a held call. Not an array of usable lines
 *  (a describer that misbehaved) ⇒ undefined, and the card falls back to the arguments. */
export function boundApprovalLines(lines: unknown): ApprovalLine[] | undefined {
  if (!Array.isArray(lines)) return undefined;
  const out: ApprovalLine[] = [];
  for (const l of lines) {
    if (out.length >= REQUESTED_LINES_MAX) break;
    const raw = typeof l === 'string' ? { text: l } : l && typeof l === 'object' ? (l as { text?: unknown; group?: unknown }) : undefined;
    if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) continue;
    const text = scrubSecretShaped(raw.text.trim()).slice(0, REQUESTED_LINE_MAX_CHARS);
    const group = typeof raw.group === 'string' && raw.group.trim() ? scrubSecretShaped(raw.group.trim()).slice(0, REQUESTED_GROUP_MAX_CHARS) : undefined;
    out.push(group ? { text, group } : { text });
  }
  return out.length > 0 ? out : undefined;
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
  delete out.requestedLines;
  delete out.sealedInput;
  return out;
};

/** ADR 1156 P2 (D10) — the largest held input kept for running. A bigger one is not sealed,
 *  and its approval works as in P1 (the model repeats the call). */
export const SEALED_INPUT_MAX_CHARS = 128 * 1024;
const SEALED_KMS = 'toolapproval:kms:v1:';
const SEALED_PLAIN = 'toolapproval:plain:v1:';

/** The AAD the input is sealed under: the row, and the digest the approval is checked
 *  against, so a sealed input copied onto another row or another ask does not open. */
function sealedInputAad(tenantId: string, conversationId: string, toolName: string, digest: string): KmsAadContext {
  return { tenantId, credentialRef: `toolapproval:${conversationId}:${toolName}:${digest}` };
}

/** Seal a held call's input for the row. Without KMS (local dev, the anonymous demo) it is
 *  stored with a plaintext marker, the `webhookSecretCodec.ts` posture. */
async function sealInput(tenantId: string, conversationId: string, toolName: string, digest: string, input: Record<string, unknown>): Promise<string | undefined> {
  let text: string;
  try { text = canonicalize(input); } catch { return undefined; }
  if (text.length > SEALED_INPUT_MAX_CHARS) return undefined;
  if (!isKmsConfigured()) return `${SEALED_PLAIN}${text}`;
  return `${SEALED_KMS}${JSON.stringify(await kmsEncrypt(text, sealedInputAad(tenantId, conversationId, toolName, digest)))}`;
}

/** Open a row's sealed input, and check it is the input the approval was given for (its
 *  digest is the row's `inputDigest`). Anything else, tamper or a wrong AAD included, is
 *  undefined: the call is then not run. */
export async function openSealedInput(r: ToolApprovalRecord): Promise<Record<string, unknown> | undefined> {
  if (!r.sealedInput || !r.inputDigest) return undefined;
  try {
    let text: string;
    if (r.sealedInput.startsWith(SEALED_KMS)) {
      text = await kmsDecrypt(JSON.parse(r.sealedInput.slice(SEALED_KMS.length)) as KmsEncryptedRecord, sealedInputAad(r.tenantId, r.conversationId, r.toolName, r.inputDigest));
    } else if (r.sealedInput.startsWith(SEALED_PLAIN) && !isKmsConfigured()) {
      // Under KMS every input is sealed with it, so a plaintext marker there was not
      // written by `sealInput`.
      text = r.sealedInput.slice(SEALED_PLAIN.length);
    } else return undefined;
    const input = JSON.parse(text) as unknown;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    return toolInputDigest(input as Record<string, unknown>) === r.inputDigest ? (input as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

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

/** What recording an ask did (ADR 1156): `pending` ⇒ the row now waits on this ask (its
 *  card is the turn named by `askId`); `replacedAskId` ⇒ an earlier card's ask was
 *  overtaken (a one-call approval or a call-grain denial for OTHER arguments);
 *  `kept` ⇒ an earlier decision stands (no new card). */
export type RecordToolApprovalResult =
  | { status: 'pending'; requestedAt: string; replacedAskId?: string }
  | { status: 'kept' };

/** Record that a tool call is awaiting approval.
 *  - no row ⇒ a `pending` row;
 *  - `pending` ⇒ arguments + `requestedAt` refreshed, origin raised (never lowered);
 *  - `approved` for a LOWER origin than this ask ⇒ re-opened as `pending` (escalation);
 *  - a one-call approval, or (ADR 1156 D6) a call-grain denial, for OTHER arguments ⇒
 *    re-opened as `pending`: it answered a different question;
 *  - otherwise (approved for this origin, or denied for these arguments or tool-wide) ⇒
 *    kept verbatim.
 *  Every write is a compare-and-swap against the row it read (FW2-CD-2), retried a
 *  bounded number of times, so a concurrent approve cannot be overwritten by a stale
 *  re-ask and two first asks cannot lose an escalation. */
export async function recordToolApprovalRequested(
  tenantId: string,
  conversationId: string,
  toolName: string,
  ask: { origin?: ApprovalOrigin; input?: Record<string, unknown>; lane?: ToolApprovalLane; askId?: string; lines?: ApprovalLine[] } = {},
): Promise<RecordToolApprovalResult> {
  const origin: ApprovalOrigin = ask.origin ?? 'baseline';
  const display = displayInput(ask.input);
  const lines = boundApprovalLines(ask.lines);
  const inputDigest = toolInputDigest(ask.input);
  // ADR 1156 P2 (D10) — in-app asks keep the full input, sealed, for running on approval.
  const sealedInput = (ask.lane ?? 'app') === 'app' && ask.input && Object.keys(ask.input).length > 0
    ? await sealInput(tenantId, conversationId, toolName, inputDigest, ask.input)
    : undefined;
  const shown = {
    inputDigest,
    ...(sealedInput ? { sealedInput } : {}),
    ...(display.text ? { requestedInput: display.text } : {}),
    ...(display.complete ? {} : { inputTruncated: true }),
    lane: ask.lane ?? 'app',
    ...(ask.askId ? { askId: ask.askId } : {}),
    ...(lines ? { requestedLines: lines } : {}),
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
      const { inputTruncated: _t, inputDigest: _d, lane: _l, askId: _a, ...rest } = withoutInput(existing);
      next = { ...rest, origin: raised, requestedAt: now(), ...shown };
    } else if (existing.status === 'approved' && rank(existing.origin) < rank(origin)) next = fresh();
    // FW2-D1 — a one-call approval covers the arguments it was shown, nothing else: an ask
    // with different arguments is a new question. ADR 1156 D6 — so does a call-grain denial.
    else if (existing.grain === 'call' && existing.inputDigest !== shown.inputDigest) next = fresh();
    else next = null; // approved for this origin (or higher), or denied — keep the decision verbatim.
    if (next === null) return { status: 'kept' };
    if (await ledger.compareAndSwap(existing, next)) {
      // The card of the ask this one overtook: a pending ask from another turn, or an
      // unused decision about other arguments.
      const replaced = existing && existing.askId && existing.askId !== ask.askId && !isExpiredAsk(existing) ? existing.askId : undefined;
      return { status: 'pending', requestedAt: next.requestedAt, ...(replaced ? { replacedAskId: replaced } : {}) };
    }
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
 *  FW2-D1: an approval's `grain` defaults to `call`, a denial's to `conversation` (ADR
 *  1156 D6: a `call` denial covers only the arguments shown); `conversation` is refused for a `channel` ask
 *  (`grain_not_allowed`), and for a row whose arguments were not all shown. */
export async function resolveToolApproval(
  tenantId: string,
  conversationId: string,
  toolName: string,
  decision: 'approved' | 'denied',
  resolvedBy: string,
  expectedRequestedAt?: string,
  grainAsked?: ToolApprovalGrain,
): Promise<ResolveToolApprovalResult> {
  // An approval defaults to this one call (FW2-D1). A denial defaults to the tool
  // (what the composer dialog's Deny has always meant); the chat card denies `call`.
  const grain: ToolApprovalGrain = grainAsked ?? (decision === 'approved' ? 'call' : 'conversation');
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
  // ADR 1156 D6 — a denial has a grain too: `call` covers the arguments shown (the row
  // keeps their digest), `conversation` blocks the tool (the composer dialog's Deny).
  // ADR 1156 P2 (D10) — only a one-call approval keeps the sealed input: it is the call
  // that will run. Every other decision drops it with the display copy.
  const keepSealed = decision === 'approved' && grain === 'call' && existing.sealedInput !== undefined;
  const updated: ToolApprovalRecord = {
    ...withoutInput(existing), status: decision, resolvedAt: now(), resolvedBy, grain,
    ...(keepSealed ? { sealedInput: existing.sealedInput } : {}),
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

/** ADR 1156 P2 (D12) — how long after its approval a one-call approval is still run by the
 *  next turn. Later, the next turn does not run it on its own (the person may have moved
 *  on); it still covers the call if the model makes it (P1). `OPENWOP_APPROVED_CALL_RUN_WINDOW_MIN`
 *  overrides; default 60 minutes. */
export const APPROVED_CALL_RUN_WINDOW_DEFAULT_MIN = 60;
function approvedCallRunWindowMs(): number {
  const raw = Number(process.env.OPENWOP_APPROVED_CALL_RUN_WINDOW_MIN);
  return (Number.isFinite(raw) && raw > 0 ? raw : APPROVED_CALL_RUN_WINDOW_DEFAULT_MIN) * 60_000;
}

/** ADR 1156 P2 (D11) — an approved call the next turn runs itself, before the model. */
export interface ApprovedCallToRun { row: ToolApprovalRecord; input: Record<string, unknown> }

/** ADR 1156 P2 (D11, D13) — the in-app one-call approvals this turn should run itself, each
 *  CLAIMED (compare-and-delete) before it is returned, so two turns cannot both run one
 *  approval and a turn re-dispatched after a crash does not run it again (at most once).
 *  Also returns the rows another turn claimed first: the caller drops them from its grant,
 *  so a model re-attempt in that turn cannot spend an approval already being run. A row
 *  whose input does not open, or whose digest no longer matches, is left in place (it still
 *  covers a re-attempt, as in P1). `OPENWOP_APPROVED_CALL_RUN=off` turns this off. */
export async function claimApprovedCallsToRun(rows: readonly ToolApprovalRecord[], nowMs: number = Date.now()): Promise<{ toRun: ApprovedCallToRun[]; lost: ToolApprovalRecord[] }> {
  const toRun: ApprovedCallToRun[] = [];
  const lost: ToolApprovalRecord[] = [];
  if (process.env.OPENWOP_APPROVED_CALL_RUN === 'off') return { toRun, lost };
  const windowMs = approvedCallRunWindowMs();
  for (const r of rows) {
    if (r.status !== 'approved' || r.grain !== 'call' || r.lane === 'channel' || !r.askId || !r.sealedInput) continue;
    const at = Date.parse(r.resolvedAt ?? '');
    if (!Number.isFinite(at) || nowMs - at > windowMs) continue;
    const input = await openSealedInput(r);
    if (!input) continue;
    if (await ledger.compareAndDelete(r)) toRun.push({ row: r, input });
    else lost.push(r);
  }
  return { toRun, lost };
}

/** ADR 1156 P2 (D10) — how long a still-PENDING ask keeps its sealed input, from its
 *  latest ask. User decision 2026-11-26: 24 hours. In-app asks have no other expiry and
 *  conversations no retention window, so without this an undecided ask kept the full
 *  input for as long as the conversation existed. Past it, an approval still works as in
 *  P1 (the model repeats the call). `OPENWOP_PENDING_SEALED_INPUT_TTL_MIN` overrides. */
export const PENDING_SEALED_INPUT_TTL_DEFAULT_MIN = 24 * 60;
function pendingSealedInputTtlMs(): number {
  const raw = Number(process.env.OPENWOP_PENDING_SEALED_INPUT_TTL_MIN);
  return (Number.isFinite(raw) && raw > 0 ? raw : PENDING_SEALED_INPUT_TTL_DEFAULT_MIN) * 60_000;
}

/** ADR 1156 P2 (D10) — a sealed input that can no longer run is not kept: its approval is
 *  not a one-call approval any more, or its run window has passed (an unreadable decision
 *  time reads as passed).
 *
 *  A PENDING ask keeps its input for `pendingSealedInputTtlMs` after its latest ask (an
 *  unreadable ask time reads as passed): it is what a one-call approval will run. This
 *  used to read every non-approved status as lapsed, so any turn (or the retention sweep)
 *  that ran while an ask was pending stripped its input, and the approval that followed
 *  had nothing to run. */
function sealedInputLapsed(r: ToolApprovalRecord, nowMs: number): boolean {
  if (r.sealedInput === undefined) return false;
  if (r.status === 'pending') {
    const asked = Date.parse(r.requestedAt);
    return !Number.isFinite(asked) || nowMs - asked > pendingSealedInputTtlMs();
  }
  if (r.status !== 'approved' || r.grain !== 'call') return true;
  const at = Date.parse(r.resolvedAt ?? '');
  return !Number.isFinite(at) || nowMs - at > approvedCallRunWindowMs();
}

/** ADR 1156 P2 (D10) — drop the sealed inputs that lapsed from a conversation's rows, and
 *  return the rows as stored. Every turn calls it, whoever acts (a fork, a participant or
 *  a channel turn never runs one, so its window would otherwise never end). A row written
 *  meanwhile wins the compare-and-swap and is returned as read; the next turn retries. */
export async function dropLapsedSealedInputs(rows: readonly ToolApprovalRecord[], nowMs: number = Date.now()): Promise<ToolApprovalRecord[]> {
  const out: ToolApprovalRecord[] = [];
  for (const r of rows) {
    if (!sealedInputLapsed(r, nowMs)) { out.push(r); continue; }
    const next: ToolApprovalRecord = { ...r };
    delete next.sealedInput;
    out.push(await ledger.compareAndSwap(r, next).catch(() => false) ? next : r);
  }
  return out;
}

/** ADR 1156 P2 (D10) — the same drop on the retention daemon's default-on tick, so a
 *  conversation that never has another turn does not keep a sealed input past its window.
 *  Skips tenants under legal hold (ADR 0951 D3). The count is of inputs dropped. */
export async function sweepLapsedSealedInputs(nowMs: number = Date.now()): Promise<PurgeOutcome> {
  let deleted = 0; let failed = 0;
  const held = new Map<string, boolean>();
  for (const r of await ledger.list()) {
    if (!sealedInputLapsed(r, nowMs)) continue;
    if (!held.has(r.tenantId)) held.set(r.tenantId, (await getRetentionHold(r.tenantId)) !== null);
    if (held.get(r.tenantId)) continue;
    const next: ToolApprovalRecord = { ...r };
    delete next.sealedInput;
    try { if (await ledger.compareAndSwap(r, next)) deleted += 1; } catch { failed += 1; }
  }
  return { deleted, failed };
}
registerDefaultWindowSweep({ feature: 'conversation-tools-sealed-input', sweep: sweepLapsedSealedInputs });

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
  // ADR 1156 D6 — a call-grain denial covers one set of arguments; folding it would remove
  // the tool. It is answered per call by `ApprovalGrant.declined` instead.
  return approvals.filter((a) => a.grain !== 'call' && (a.status === 'denied' || (!channelTurn && a.status === 'approved')));
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
  /** ADR 1156 D5 — the call each spent row let through (`callKey` as passed to `check`). */
  spentCalls?(): Array<{ row: ToolApprovalRecord; callKey: string }>;
  /** ADR 1156 D6 — has the person declined exactly this call (a call-grain denial whose
   *  digest matches)? The gate then refuses it at once instead of holding it again. */
  declined?(toolName: string, input: Record<string, unknown> | undefined): boolean;
}
export function makeApprovalGrant(rows: readonly ToolApprovalRecord[], opts: { singleUse: boolean; requireDigest: boolean }): ApprovalGrant {
  // CHAN-F17 — an expired one-call channel approval answers nothing (the owner approves again).
  const approved = rows.filter((r) => r.status === 'approved' && !isExpired(r));
  const callDenials = rows.filter((r) => r.status === 'denied' && r.grain === 'call' && r.inputDigest !== undefined);
  const used = new Set<ToolApprovalRecord>();
  const usedBy = new Map<ToolApprovalRecord, string>();
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
        if (row && (opts.singleUse || row.grain === 'call')) { used.add(row); usedBy.set(row, callKey); }
        chosen.set(k, row);
      }
      if (row === null) return false;
      return origin !== 'policy' || row.origin === 'policy';
    },
    spent: () => [...used],
    spentCalls: () => [...usedBy].map(([row, callKey]) => ({ row, callKey })),
    declined(toolName, input) {
      const mine = callDenials.filter((r) => r.toolName === toolName);
      if (mine.length === 0) return false;
      const digest = toolInputDigest(input);
      return mine.some((r) => r.inputDigest === digest);
    },
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
    // ADR 1156 P2 (D10): the sealed input of a call the subject approved goes too; the
    // approval then works as in P1 (the model repeats the call).
    const erased: ToolApprovalRecord = { ...r, resolvedBy: ERASED };
    delete erased.sealedInput;
    await ledger.compareAndSwap(r, erased);
  }
}

/** Registered from the feature's boot path by MODULE-LEVEL reference (the registry
 *  dedupes by reference). */
export function registerConversationToolApprovalsErasure(): void {
  registerSubjectEraser(eraseConversationToolApprovalsSubject);
}
