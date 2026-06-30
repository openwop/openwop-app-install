/**
 * Pending-approval queue — host extension (non-normative).
 *
 * The reference implementation of the "agents propose, humans dispose" gate.
 * When a roster member runs at `autonomyLevel: 'review'` (host/rosterService.ts)
 * its heartbeat does NOT start the picked run; it queues a PendingApproval here
 * describing the proposed action (which workflow, on which board card). A human
 * reviews the proposal in the approvals inbox and either:
 *   - CLAIMS it — an affirmative sign-off that starts the proposed run, OR
 *   - REJECTS it — the proposal is dismissed and the card stays in To Do.
 *
 * This is a PRE-EXECUTION gate, deliberately distinct from the normative
 * `interrupt` kind (interrupt.md), which suspends a run that is already
 * in flight. The propose moment in this sample is the heartbeat's pick
 * decision — before any run exists — so a lightweight durable queue models it
 * more honestly than forcing every demo workflow to carry an approval node.
 *
 * Read-through, per-entity durable store (host/hostExtPersistence.ts): safe
 * across instances + restart-durable, like the roster/kanban surfaces.
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** A proposed-but-unstarted action awaiting human sign-off. */
export interface PendingApproval {
  /** `appr:<uuid>`. */
  approvalId: string;
  tenantId: string;
  /** The roster member that proposed the action. */
  rosterId: string;
  persona: string;
  /** The workflow the member proposes to run. */
  workflowId: string;
  /** ADR 0023 §12 T4 — when set, this approval carries an Executive-Assistant
   *  outbound action (`PendingAction.actionId`): the SAME queue, inbox, and
   *  claim/reject flow (ADR 0025 §4 "no new approval store"); the claim route
   *  branches here instead of starting `workflowId` (execution is T6). */
  actionId?: string;
  /** Discriminator for renderers; absent ⇒ 'run-proposal' (back-compat). */
  kind?: 'run-proposal' | 'assistant-action' | 'content-publish';
  /** ADR 0066 — when `kind: 'content-publish'`, this approval gates a CMS page's
   *  publish (`draft → in_review → published`). `rosterId`/`persona`/`workflowId`
   *  are empty (no agent, no run); the decide path is the CMS feature's
   *  content-approval handler, which transitions the page. The SAME queue +
   *  inbox + CAS resolve (ADR 0025 §4 "no new approval store"). */
  orgId?: string;
  pageId?: string;
  pageTitle?: string;
  /** The board card the proposal originated from (the "cited source"). */
  boardId?: string;
  cardId?: string;
  cardTitle?: string;
  /** Human-readable one-liner, e.g. "Run intake-triage on 'New family: Garcia'". */
  proposal: string;
  status: ApprovalStatus;
  createdAt: string;
  /** Set when claimed or rejected. */
  resolvedAt?: string;
  /** The run a CLAIM started (absent until claimed). */
  runId?: string;
  /** Optional reviewer note captured at claim/reject time. */
  note?: string;
  /** Multi-approver / quorum policy (ADR 0070). Absent OR `requiredApprovals <= 1`
   *  ⇒ the legacy single-decision path (a claim/reject resolves immediately).
   *  When `requiredApprovals > 1`, each claim/reject is an eligibility-checked VOTE
   *  recorded in the durable `review:decision` ledger keyed by `approvalId`; the
   *  final transition (run start / reject) fires exactly once when policy is met. */
  policy?: ApprovalPolicy;
}

export interface ApprovalPolicy {
  requiredApprovals: number;
  /** Eligible approver subject refs; empty (and no group/role refs) ⇒ any holder
   *  of `approvals:respond`. */
  approverRefs?: string[];
  /** ADR 0075 §D2 — accessControl group refs whose members are eligible. Resolved
   *  LIVE to subjects at decision time (ADR 0075 §D3), tenant/org-scoped (§D5).
   *  Host-extension only — NOT on the OpenWOP wire (interrupt-path portability is
   *  RFC 0104). */
  approverGroupRefs?: string[];
  /** ADR 0075 §D2 — accessControl role refs (built-in or custom) whose effective
   *  holders are eligible. Same live, tenant/org-scoped resolution as groups. */
  approverRoleRefs?: string[];
  /** How rejections fail the gate. Default: a single reject fails it. */
  rejectionPolicy?: 'any' | 'majority';
}

const approvals = new DurableCollection<PendingApproval>('approval', (a) => a.approvalId);

// ── tenant/status secondary index (ADR 0029, T8) ──
// `listApprovals` + `hasPendingApprovalForCard` run on EVERY heartbeat poll;
// they were full cross-tenant scans. Index ids embed (tenant, status) so the
// hot path is a bounded prefix scan; rows re-checked against the source of
// truth (stale rows tolerated, never trusted).
interface ApprovalIndexRow {
  ixId: string;
  approvalId: string;
}
const approvalsByTenantStatus = new DurableCollection<ApprovalIndexRow>('approval:by-tenant-status', (r) => r.ixId);
const approvalIxId = (tenantId: string, status: ApprovalStatus, approvalId: string): string =>
  `${tenantId}:${status}:${approvalId}`;

async function indexApproval(a: PendingApproval, prevStatus?: ApprovalStatus): Promise<void> {
  if (prevStatus !== undefined && prevStatus !== a.status) {
    await approvalsByTenantStatus.delete(approvalIxId(a.tenantId, prevStatus, a.approvalId));
  }
  await approvalsByTenantStatus.put({ ixId: approvalIxId(a.tenantId, a.status, a.approvalId), approvalId: a.approvalId });
}

/** One-time boot sweep: index approval rows written before the index existed
 *  (same discipline as `backfillCommitmentIndexes`). Without this, every
 *  pre-upgrade pending approval would vanish from the inbox and the
 *  heartbeat would re-propose cards it can no longer see as pending.
 *  Idempotent — puts are upserts. Called from app boot. */
export async function backfillApprovalIndexes(): Promise<number> {
  const all = await approvals.list();
  for (const a of all) await indexApproval(a);
  return all.length;
}

function nowIso(): string {
  return new Date().toISOString();
}

// Per-approval in-process serialization. The durable store has no
// compare-and-swap, so two concurrent resolves could each read `pending` before
// either writes. Chaining each key's work serializes resolves within one
// process → exactly one winner. (Cross-INSTANCE races still need the
// conditional-write a production host provides; documented on resolveApproval.)
const resolveChains = new Map<string, Promise<unknown>>();
function withApprovalLock<T>(approvalId: string, fn: () => Promise<T>): Promise<T> {
  const prior = resolveChains.get(approvalId) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  resolveChains.set(approvalId, tail);
  // Drop the entry once this is the last queued work for the key (bounds the map).
  void tail.then(() => {
    if (resolveChains.get(approvalId) === tail) resolveChains.delete(approvalId);
  });
  return run;
}

export async function createApproval(input: {
  tenantId: string;
  rosterId: string;
  persona: string;
  workflowId: string;
  boardId?: string;
  cardId?: string;
  cardTitle?: string;
  proposal: string;
  /** Multi-approver / quorum policy (ADR 0070). Omit for the single-decision gate. */
  policy?: ApprovalPolicy;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: input.rosterId,
    persona: input.persona,
    workflowId: input.workflowId,
    boardId: input.boardId,
    cardId: input.cardId,
    cardTitle: input.cardTitle,
    proposal: input.proposal,
    ...(input.policy ? { policy: input.policy } : {}),
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/**
 * Create the approval act for an Executive-Assistant outbound action
 * (ADR 0023 §12 T4). Same durable queue + CAS resolve as run proposals —
 * the assistant is one more proposer on the single loop, attributed to its
 * chief-of-staff identity rather than a board card.
 */
export async function createAssistantActionApproval(input: {
  tenantId: string;
  actionId: string;
  /** The action kind + a one-line summary, e.g. `email.send: "Re: Q3 numbers" to dana@…`. */
  proposal: string;
  /** The REAL Chief-of-Staff roster member this approval is attributed to
   *  (ADR 0023, corrected 2026-06-11). The caller resolves it via
   *  `ensureChiefOfStaff(tenantId)`; this used to be a literal `'assistant'`
   *  pseudo-id that resolved to no RosterEntry (the parallel-architecture bug). */
  rosterId: string;
  persona: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: input.rosterId,
    persona: input.persona,
    workflowId: '',
    actionId: input.actionId,
    kind: 'assistant-action',
    proposal: input.proposal,
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/**
 * The assistant-action decision handler, registered by the assistant FEATURE
 * at boot (core owns the hook; the feature depends on core, never the
 * reverse — the `connectionInjection`/`featureSurfaces` discipline). The
 * approvals routes call this for `actionId`-carrying approvals so the claim
 * path and the assistant's own approve/reject route share ONE implementation.
 */
export type AssistantActionDecision = {
  approval: PendingApproval;
  /** The updated PendingAction row, host-shaped (projected by the feature). */
  action: Record<string, unknown> | null;
  changed: boolean;
};
export type AssistantActionApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
) => Promise<AssistantActionDecision | null>;

let actionApprovalHandler: AssistantActionApprovalHandler | null = null;

export function registerAssistantActionApprovalHandler(fn: AssistantActionApprovalHandler): void {
  actionApprovalHandler = fn;
}

export function getAssistantActionApprovalHandler(): AssistantActionApprovalHandler | null {
  return actionApprovalHandler;
}

/**
 * Projector for an assistant-action's rich card metadata (risk tier, reason,
 * source citations, recipient diff, taint, draft). Registered by the assistant
 * FEATURE at boot — core's approvals LIST route calls it to embed the typed
 * PendingAction onto each `actionId`-carrying approval row so the inbox can
 * render the rich ActionCard, WITHOUT core importing the feature (direction:
 * feature → core only). Returns a host-shaped row (internal columns projected
 * out) or null when the action is missing/cross-tenant. */
export type AssistantActionProjector = (
  tenantId: string,
  actionId: string,
) => Promise<Record<string, unknown> | null>;

let actionProjector: AssistantActionProjector | null = null;

export function registerAssistantActionProjector(fn: AssistantActionProjector): void {
  actionProjector = fn;
}

export function getAssistantActionProjector(): AssistantActionProjector | null {
  return actionProjector;
}

/**
 * Create a CMS content-publish approval (ADR 0066). Same durable queue + CAS
 * resolve as run proposals/assistant actions — a CMS editor is one more proposer
 * on the single loop. No agent, no run: `rosterId`/`persona`/`workflowId` are
 * empty; the decide path is the CMS feature's content-approval handler, which
 * transitions the page. NOT a second approval store (ADR 0025 §4).
 */
export async function createContentApproval(input: {
  tenantId: string;
  orgId: string;
  pageId: string;
  pageTitle: string;
  proposal: string;
  /** Multi-approver / quorum policy (ADR 0070). Omit for the single-decision gate. */
  policy?: ApprovalPolicy;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: '',
    persona: '',
    workflowId: '',
    kind: 'content-publish',
    orgId: input.orgId,
    pageId: input.pageId,
    pageTitle: input.pageTitle,
    proposal: input.proposal,
    ...(input.policy ? { policy: input.policy } : {}),
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/**
 * The content-publish decision handler, registered by the CMS FEATURE at boot
 * (core owns the hook; the feature depends on core, never the reverse — the
 * same discipline as the assistant-action handler). The approvals routes call
 * this for `kind: 'content-publish'` approvals so the inbox claim/reject path
 * and the CMS publish flow share ONE implementation. The handler enforces org
 * RBAC (`host:members:manage`) + IDOR and transitions the page.
 */
export type ContentApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let contentApprovalHandler: ContentApprovalHandler | null = null;

export function registerContentApprovalHandler(fn: ContentApprovalHandler): void {
  contentApprovalHandler = fn;
}

export function getContentApprovalHandler(): ContentApprovalHandler | null {
  return contentApprovalHandler;
}

export async function getApproval(approvalId: string): Promise<PendingApproval | null> {
  return approvals.get(approvalId);
}

/** Tenant-scoped list, newest first; optionally filtered by status.
 *  Indexed (ADR 0029): bounded prefix scan of the (tenant, status) slice →
 *  point gets; the row read is the source of truth (stale rows re-checked). */
export async function listApprovals(tenantId: string, status?: ApprovalStatus): Promise<PendingApproval[]> {
  const statuses: ApprovalStatus[] = status ? [status] : ['pending', 'approved', 'rejected'];
  const ixRows = (
    await Promise.all(statuses.map((st) => approvalsByTenantStatus.listByPrefix(`${tenantId}:${st}:`)))
  ).flat();
  const fetched = await Promise.all(ixRows.map((r) => approvals.get(r.approvalId)));
  return fetched
    .filter((a): a is PendingApproval => a !== null && a.tenantId === tenantId && (status ? a.status === status : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** True when this card already has a pending approval — used by the heartbeat
 *  to avoid re-proposing the same card on every poll. */
export async function hasPendingApprovalForCard(tenantId: string, cardId: string): Promise<boolean> {
  return (await listApprovals(tenantId, 'pending')).some((a) => a.cardId === cardId);
}

/** True when this CMS page already has a pending content-publish approval —
 *  used by `submit` to avoid fanning out duplicate approvals (ADR 0066). */
export async function hasPendingApprovalForPage(tenantId: string, pageId: string): Promise<boolean> {
  return (await listApprovals(tenantId, 'pending')).some((a) => a.kind === 'content-publish' && a.pageId === pageId);
}

/** Resolve an approval (claim → approved, reject → rejected). The `pending`
 *  guard is the lock: `changed` is true only for the call that performed the
 *  pending→resolved transition, so a caller can gate a side effect on it (e.g.
 *  only the winning claim dispatches the run). Returns null if missing.
 *
 *  A7 — the pending→resolved transition is now an atomic compare-and-swap
 *  (`DurableCollection.compareAndSwap` → storage `kvCompareAndSwap`), correct
 *  ACROSS instances: exactly one concurrent claim wins (`changed: true`); the
 *  losers observe the already-resolved row (`changed: false`). The in-process
 *  `withApprovalLock` stays as a same-process fast-path, but the CAS is the hard
 *  guarantee — the previous get→put double-dispatch window is closed. */
export function resolveApproval(
  approvalId: string,
  outcome: { status: 'approved' | 'rejected'; runId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  return withApprovalLock(approvalId, async () => {
    const approval = await approvals.get(approvalId);
    if (!approval) return null;
    if (approval.status !== 'pending') return { approval, changed: false };
    const next: PendingApproval = {
      ...approval,
      status: outcome.status,
      resolvedAt: nowIso(),
      ...(outcome.runId ? { runId: outcome.runId } : {}),
      ...(outcome.note !== undefined ? { note: outcome.note } : {}),
    };
    // Atomic: swap only if the row is still exactly the pending one we read.
    const swapped = await approvals.compareAndSwap(approval, next);
    if (!swapped) {
      // Lost the race — another claim resolved it first. Report the resolved state.
      const current = await approvals.get(approvalId);
      return current ? { approval: current, changed: false } : null;
    }
    await indexApproval(next, approval.status);
    // Bound the store: resolved rows accumulate forever otherwise, growing the
    // per-heartbeat scan. Prune the tenant's oldest resolved entries past the cap.
    await pruneResolved(approval.tenantId);
    return { approval: next, changed: true };
  });
}

/** Re-open a just-resolved approval back to `pending` (ADR 0066 compensation).
 *  The content-publish decide path resolves the approval BEFORE the page
 *  transition (the CAS gates the side effect); if the transition then fails
 *  (the page left `in_review`, or was deleted), this restores the approval so a
 *  failed decide never consumes it — the row never lies about what happened.
 *  Idempotent + CAS-guarded; a no-op if the row is already pending/gone. */
export async function reopenApproval(approvalId: string): Promise<void> {
  await withApprovalLock(approvalId, async () => {
    const a = await approvals.get(approvalId);
    if (!a || a.status === 'pending') return;
    const { resolvedAt: _resolvedAt, ...rest } = a;
    const reopened: PendingApproval = { ...rest, status: 'pending' };
    const swapped = await approvals.compareAndSwap(a, reopened);
    if (swapped) await indexApproval(reopened, a.status);
  });
}

/** Reject any pending content-publish approval for a page (ADR 0066). Called
 *  when an admin moves the page out of `in_review` through the direct
 *  reject/unpublish routes while the approval gate is ON, so the inbox row
 *  doesn't orphan (the page is the single source of truth for its status). */
export async function rejectPendingApprovalForPage(tenantId: string, pageId: string, note: string): Promise<void> {
  const pending = (await listApprovals(tenantId, 'pending')).filter(
    (a) => a.kind === 'content-publish' && a.pageId === pageId,
  );
  for (const a of pending) await resolveApproval(a.approvalId, { status: 'rejected', note });
}

/** Attach the started run to an already-approved approval (post-dispatch). */
export async function attachRunId(approvalId: string, runId: string): Promise<void> {
  const approval = await approvals.get(approvalId);
  if (!approval) return;
  approval.runId = runId;
  await approvals.put(approval);
}

/** Cascade: remove every approval (pending OR resolved) proposed for a roster
 *  member, plus its (tenant, status) index row. Called when the member is
 *  deleted so a now-gone agent leaves no ghost proposal in the inbox and no
 *  stale row in the idempotency index (`hasPendingApprovalForCard`). Returns
 *  the count removed. */
export async function deleteApprovalsForRoster(tenantId: string, rosterId: string): Promise<number> {
  const all = await listApprovals(tenantId);
  let removed = 0;
  for (const a of all) {
    if (a.rosterId !== rosterId) continue;
    await approvals.delete(a.approvalId);
    await approvalsByTenantStatus.delete(approvalIxId(tenantId, a.status, a.approvalId));
    removed += 1;
  }
  return removed;
}

const RESOLVED_RETENTION = 100;

/** Keep only the most-recent `keep` resolved approvals for a tenant; delete the
 *  rest. Pending approvals are never pruned. */
async function pruneResolved(tenantId: string, keep = RESOLVED_RETENTION): Promise<void> {
  const resolved = (
    await Promise.all([listApprovals(tenantId, 'approved'), listApprovals(tenantId, 'rejected')])
  )
    .flat()
    .sort((a, b) => (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt));
  for (const stale of resolved.slice(keep)) {
    await approvals.delete(stale.approvalId);
    await approvalsByTenantStatus.delete(approvalIxId(tenantId, stale.status, stale.approvalId));
  }
}

/** Test-only: drop all approvals. */
export async function __resetApprovalStore(): Promise<void> {
  await approvals.__clear();
  await approvalsByTenantStatus.__clear();
}
