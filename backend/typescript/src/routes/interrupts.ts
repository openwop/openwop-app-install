/**
 * Interrupt-resolution routes:
 *   POST /v1/runs/{runId}/interrupts/{nodeId}    — node-scoped resolve
 *   POST /v1/interrupts/{token}                   — token-scoped resolve (unauth-friendly)
 *   GET  /v1/interrupts/{token}                   — inspect (returns kind + resumeSchema)
 *
 * After resolution, the run resumes via executor.executeRun() with
 * the suspended node's index + the resolved value as input.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Express } from 'express';
import type { ResolveInterruptRequest } from '@openwop/openwop';
import type { Storage } from '../storage/storage.js';
import { OpenwopError, type InterruptRecord } from '../types.js';
import { getSuspendManager } from '../executor/suspendManager.js';
import { getEventLog } from '../executor/eventLog.js';
import { executeRun } from '../executor/executor.js';
import { timeoutApprovalGateIfDue } from '../executor/approvalGateTimeout.js';
import { createLogger } from '../observability/logger.js';
import { createHostAdapterSuite, type HostAdapterSuite } from '../host/index.js';
import { handleConversationResolve } from '../host/conversationExchange.js';

const log = createLogger('routes.interrupts');

interface Deps {
  storage: Storage;
  hostSuite?: HostAdapterSuite;
}

/** Constant-time token re-comparison (RFC 0093 §B.3). The lookup itself is a
 *  DB unique-index probe; this re-check makes the in-process comparison that
 *  gates the response explicitly timing-safe. */
function tokenMatches(presented: string, stored: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** RFC 0093 §B.1 — a token past its `expiresAt` is refused with the canonical
 *  410 `interrupt_expired` envelope. Pre-migration rows (no expiresAt) never
 *  expire. */
function interruptTokenExpired(interrupt: InterruptRecord, now: number = Date.now()): boolean {
  if (!interrupt.expiresAt) return false;
  const expires = Date.parse(interrupt.expiresAt);
  return Number.isFinite(expires) && now > expires;
}

/** Run statuses that invalidate an unresolved interrupt's token
 *  (RFC 0093 §B.2 — resolved, or the owning run cancelled or completed). */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/**
 * Shared signed-token gate for GET + POST /v1/interrupts/{token}
 * (RFC 0093 §B.1-B.3). Looks the token up, lazily times out an overdue
 * approval gate, then enforces the lifecycle refusals in spec order:
 *   404 invalid_interrupt_token  — unknown token
 *   409 interrupt_already_resolved — resolved (incl. a gate this call just
 *       timed out), or the owning run is terminal while unresolved
 *   410 interrupt_expired — past expiresAt while unresolved
 * Returns the interrupt for the happy path. When `allowResolved` is true
 * (inspect), a resolved interrupt is returned instead of refused so the
 * inspect view can report `resolved: true`.
 */
async function loadInterruptByTokenChecked(
  storage: Storage,
  token: string,
  opts: { allowResolved: boolean },
): Promise<InterruptRecord> {
  const interrupt = await storage.getInterruptByToken(token);
  if (!interrupt || !tokenMatches(token, interrupt.token)) {
    throw new OpenwopError('invalid_interrupt_token', 'unknown interrupt token', 404);
  }
  // Lazy half of the RFC 0093 §D timeout enforcement — an overdue approval
  // gate auto-rejects before this access can act on it.
  if (await timeoutApprovalGateIfDue(storage, interrupt)) {
    throw new OpenwopError('interrupt_already_resolved', 'approval gate timed out (auto-rejected; reason: timeout)', 409);
  }
  if (interrupt.resolvedAt) {
    if (opts.allowResolved) return interrupt;
    throw new OpenwopError('interrupt_already_resolved', 'interrupt already resolved', 409);
  }
  if (interruptTokenExpired(interrupt)) {
    throw new OpenwopError('interrupt_expired', 'interrupt token past its expiry', 410, {
      expiresAt: interrupt.expiresAt,
    });
  }
  // Unresolved token on a terminal run: invalidated per RFC 0093 §B.2.
  const run = await storage.getRun(interrupt.runId);
  if (run && TERMINAL_RUN_STATUSES.has(run.status)) {
    throw new OpenwopError(
      'interrupt_already_resolved',
      `interrupt token invalidated — owning run is ${run.status}`,
      409,
      { runStatus: run.status },
    );
  }
  return interrupt;
}

export function registerInterruptRoutes(app: Express, deps: Deps): void {
  const { storage } = deps;
  // Lazily build a host suite for workflow lookups on resume; routes layer
  // below also reuses this. The shared suite is constructed in index.ts;
  // this fallback keeps the file self-contained for tests.
  const hostSuite = deps.hostSuite ?? createHostAdapterSuite({ storage });

  app.post('/v1/runs/:runId/interrupts/:nodeId', async (req, res, next) => {
    try {
      const { runId, nodeId } = req.params;
      const interrupt = await storage.getInterruptByNode(runId, nodeId);
      if (!interrupt) throw new OpenwopError('interrupt_not_found', 'no open interrupt for this node', 404);
      // Cascaded-cancel detection per `interrupt-profiles.md
      // §openwop-interrupt-parent-child`: when the run is cancelled,
      // the interrupt is invalidated. Prefer 410 Gone over 409 so the
      // contract distinguishes "resource removed by external state"
      // from "resource already resolved by you" — the conformance suite
      // accepts both, but Gone is the more honest answer.
      const currentRun = await storage.getRun(runId);
      if (currentRun && currentRun.status === 'cancelled') {
        throw new OpenwopError('interrupt_gone', 'interrupt invalidated — run was cancelled', 410);
      }
      // RFC 0093 §D — lazy gate-timeout check: an overdue approval gate
      // auto-rejects (fail closed) before this vote/resolve can land.
      if (await timeoutApprovalGateIfDue(storage, interrupt)) {
        throw new OpenwopError('interrupt_already_resolved', 'approval gate timed out (auto-rejected; reason: timeout)', 409);
      }
      if (interrupt.resolvedAt) throw new OpenwopError('interrupt_already_resolved', 'interrupt already resolved', 409);
      // Conversation primitive (RFC 0005 §D/§E): an `exchange` processes the
      // turn + agent reply and STAYS suspended; only `close` resumes. Routed to
      // the conversation handler, which validates the turn itself.
      if (interrupt.kind === 'conversation') {
        const result = await handleConversationResolve(
          storage, interrupt, (req.body as { resumeValue?: unknown })?.resumeValue,
          (id, val) => resolveAndResume(storage, hostSuite, id, val),
        );
        const cRun = await storage.getRun(runId);
        res.json({ runId, nodeId, status: cRun?.status ?? 'waiting-input', conversation: { operation: result.operation, turns: result.turns.length } });
        return;
      }
      const body = req.body as ResolveInterruptRequest;
      validateResumeValue(interrupt, body?.resumeValue);
      await resolveAndResume(storage, hostSuite, interrupt.interruptId, body?.resumeValue);
      const run = await storage.getRun(runId);
      res.json({ runId, nodeId, status: run?.status ?? 'running' });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/interrupts/:token', async (req, res, next) => {
    try {
      const { token } = req.params;
      // RFC 0093 §B lifecycle gate: 404 unknown / 409 resolved-or-run-terminal
      // / 410 expired — see loadInterruptByTokenChecked.
      const interrupt = await loadInterruptByTokenChecked(storage, token, { allowResolved: false });
      const body = req.body as { resumeValue?: unknown };
      // External-event interrupts validate correlation per
      // `interrupt-profiles.md §openwop-interrupt-external-event`:
      // the resume payload MUST match every field in
      // `interrupt.data.correlation`. Mismatched correlation
      // returns 422 without resuming.
      if (interrupt.kind === 'external-event') {
        const violation = checkExternalEventCorrelation(interrupt.data, body?.resumeValue);
        if (violation) {
          throw new OpenwopError(
            'validation_error',
            `External event correlation mismatch: ${violation}`,
            422,
            { mismatch: violation },
          );
        }
      }
      await resolveAndResume(storage, hostSuite, interrupt.interruptId, body?.resumeValue);
      const run = await storage.getRun(interrupt.runId);
      res.json({ runId: interrupt.runId, nodeId: interrupt.nodeId, status: run?.status });
    } catch (err) {
      next(err);
    }
  });

  // Authenticated list of open interrupts for a run. Returns tokens —
  // public event log no longer carries them (see executor.ts §node.suspended).
  //
  // Vendor-prefixed under /v1/host/openwop-app/* per host-extensions.md
  // §"Canonical prefixes". This endpoint is a strong RFC candidate —
  // every host that strips tokens from the public event log needs a
  // way for authed callers to list open interrupts with tokens. For
  // now it stays sample-scoped to avoid contract drift.
  app.get('/v1/host/openwop-app/runs/:runId/interrupts', async (req, res, next) => {
    try {
      const run = await storage.getRun(req.params.runId);
      if (!run) throw new OpenwopError('run_not_found', `run ${req.params.runId} not found`, 404);
      const open = await storage.listOpenInterrupts(run.runId);
      // RFC 0093 §D lazy enforcement on the read path: an overdue approval
      // gate auto-rejects here and drops out of the "open" listing.
      const stillOpen: typeof open[number][] = [];
      for (const it of open) {
        if (!(await timeoutApprovalGateIfDue(storage, it))) stillOpen.push(it);
      }
      res.json({
        runId: run.runId,
        interrupts: stillOpen.map((it) => ({
          interruptId: it.interruptId,
          nodeId: it.nodeId,
          kind: it.kind,
          token: it.token,
          data: it.data,
          resumeSchema: it.resumeSchema,
          createdAt: it.createdAt,
          ...(it.expiresAt ? { expiresAt: it.expiresAt } : {}),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/interrupts/:token', async (req, res, next) => {
    try {
      // RFC 0093 §B.4 — a resolve-intent token authorizes inspect too, so the
      // same lifecycle gate applies (410 expired / 409 run-terminal). A
      // RESOLVED interrupt stays inspectable (`resolved: true`) — the
      // already-resolved 409 belongs to the resolve surface.
      const interrupt = await loadInterruptByTokenChecked(storage, req.params.token, { allowResolved: true });
      res.json({
        kind: interrupt.kind,
        key: interrupt.interruptId,
        resumeSchema: interrupt.resumeSchema,
        data: interrupt.data,
        // RFC 0093 §B.4 — inspect reports the token's expiry.
        ...(interrupt.expiresAt ? { expiresAt: interrupt.expiresAt } : {}),
        resolved: interrupt.resolvedAt != null,
      });
    } catch (err) {
      next(err);
    }
  });
}

/**
 * Validate `resumeValue` against the interrupt's declared shape.
 * Per `interrupt.md §"resumeSchema"`: a resolve payload that
 * violates the schema MUST be rejected with 400 (validation_error)
 * or 422. Today we cover the common-case approval-gate enum check
 * (data.actions must contain resumeValue.action) without pulling
 * Ajv into the route layer; richer JSON-Schema validation can stack
 * later as resume contracts grow.
 */
function validateResumeValue(
  interrupt: { kind: string; data: unknown; resumeSchema?: unknown },
  resumeValue: unknown,
): void {
  if (interrupt.kind !== 'approval') return;
  const data = (interrupt.data ?? {}) as { actions?: unknown };
  if (!Array.isArray(data.actions)) return;
  const allowed = data.actions.filter((a): a is string => typeof a === 'string');
  if (allowed.length === 0) return;
  const action = (resumeValue && typeof resumeValue === 'object'
    ? (resumeValue as { action?: unknown }).action
    : undefined);
  if (typeof action !== 'string' || !allowed.includes(action)) {
    throw new OpenwopError(
      'validation_error',
      `resumeValue.action MUST be one of [${allowed.join(', ')}]; received ${JSON.stringify(action)}.`,
      400,
      { allowed, received: action },
    );
  }
}

/** Per `interrupt-profiles.md §openwop-interrupt-external-event`:
 *  the resume payload's fields MUST match every field in the
 *  interrupt's `data.correlation` object. Returns null on match, or
 *  a description of the first mismatch on miss.
 *
 *  Match semantics are deep-equal on each correlation key. Extra
 *  fields in the resume payload (e.g., the test's
 *  `externalReference`) are ignored — only the correlation keys
 *  declared by the suspended node need to match. */
function checkExternalEventCorrelation(
  interruptData: unknown,
  resumeValue: unknown,
): string | null {
  const data = (interruptData ?? {}) as { correlation?: unknown };
  const correlation = data.correlation;
  if (!correlation || typeof correlation !== 'object') return null;
  if (!resumeValue || typeof resumeValue !== 'object') {
    return 'resumeValue MUST be an object when interrupt declares correlation';
  }
  const rv = resumeValue as Record<string, unknown>;
  for (const [key, expected] of Object.entries(correlation as Record<string, unknown>)) {
    if (JSON.stringify(rv[key]) !== JSON.stringify(expected)) {
      return `correlation.${key} expected ${JSON.stringify(expected)}, got ${JSON.stringify(rv[key])}`;
    }
  }
  return null;
}

/** Per-interrupt vote ledger for quorum gates per
 *  `interrupt-profiles.md §openwop-interrupt-quorum`. In-memory by
 *  design — votes are ephemeral per suspend cycle; if the host
 *  process restarts, the run resumes from the persisted interrupt
 *  with vote count zero (acceptable: spec requires the votes to be
 *  visible during the gate's lifetime, not durable across restarts). */
const quorumVotes = new Map<string, { accepts: string[]; rejects: string[] }>();

/** Per-run resume serialization queue. See `resolveAndResume` below
 *  for the race this guards against. Keyed by runId; each entry is
 *  the tail of a promise chain whose `.then(…)` reads the freshest
 *  persisted `schedulerSnapshot`, dispatches `executeRun`, and waits
 *  for that executor to settle before unblocking the next resume.
 *  In-memory by design — same lifetime as the per-run interrupt
 *  state and the in-flight HTTP requests; a process restart drains
 *  the queue, which is fine since each resume reads its snapshot
 *  fresh anyway. */
const runResumeChains = new Map<string, Promise<void>>();

/** Result of feeding one vote into a quorum gate. `override` is set when the
 *  vote took the gate's override path (RFC 0093 §D.2) — the caller MUST then
 *  emit `approval.overridden { principal, reason }` + an audit entry per
 *  `interrupt-profiles.md` §"Approval gate". */
interface QuorumVoteResult {
  outcome: 'accept-quorum-met' | 'reject-majority' | 'pending' | 'accept-override';
  override?: { principal: string; reason: string };
}

/** Accumulate a quorum vote. Returns:
 *   - outcome 'accept-quorum-met' → run can resume with accepted outcome
 *   - outcome 'accept-override' → an override principal bypassed quorum
 *     (only when the gate config sets `overrideBypassesQuorum: true` —
 *     RFC 0093 §D.2; default false ⇒ the override counts as ONE vote)
 *   - outcome 'reject-majority' → gate fails with rejection
 *   - outcome 'pending' → record vote, return 200 to client, DON'T resume
 *   - null → not a quorum gate; caller proceeds with normal resume */
function recordQuorumVote(
  interruptId: string,
  interruptData: unknown,
  resumeValue: unknown,
): QuorumVoteResult | null {
  const data = (interruptData ?? {}) as {
    requiredApprovals?: number;
    rejectionPolicy?: string;
    override?: unknown;
    overrideBypassesQuorum?: unknown;
  };
  const requiredApprovals = typeof data.requiredApprovals === 'number' && data.requiredApprovals > 1
    ? data.requiredApprovals
    : 0;
  if (requiredApprovals === 0) return null; // not a quorum gate
  const rv = (resumeValue ?? {}) as { action?: string; voter?: string; override?: unknown; reason?: unknown };

  // Override path (RFC 0093 §D.2 + interrupt-profiles.md §"Approval gate").
  // A vote takes the override path when it says so (`action: 'override'` or
  // `override: true` alongside an accept) AND the gate's config actually
  // declares an `override` block — a gate without one has no override path
  // to take (fail closed: the flag alone grants nothing).
  const isOverrideAttempt = rv.action === 'override' || (rv.action === 'accept' && rv.override === true);
  const gateHasOverridePath = !!data.override && typeof data.override === 'object';
  if (isOverrideAttempt && gateHasOverridePath) {
    // `reason` is REQUIRED on the override path (spec: approval.overridden
    // carries { principal, reason } with reason REQUIRED).
    if (typeof rv.reason !== 'string' || rv.reason.length === 0) {
      throw new OpenwopError(
        'validation_error',
        'The approval-gate override path requires a non-empty `reason` (interrupt-profiles.md §"Approval gate").',
        400,
        { field: 'reason' },
      );
    }
    const principal = typeof rv.voter === 'string' ? rv.voter : 'unknown';
    const override = { principal, reason: rv.reason };
    if (data.overrideBypassesQuorum === true) {
      // Opt-in bypass: a single override accept resolves the gate.
      return { outcome: 'accept-override', override };
    }
    // Default (false/absent): the override principal's grant counts as ONE
    // quorum vote — fall through to the ordinary accept bookkeeping below,
    // still carrying the override marker for the event + audit trail.
    const tally = tallyVote(interruptId, requiredApprovals, data.rejectionPolicy, 'accept', principal);
    return { outcome: tally, override };
  }

  if (rv.action !== 'accept' && rv.action !== 'reject') return null;
  const voter = typeof rv.voter === 'string' ? rv.voter : `anon-${(quorumVotes.get(interruptId)?.accepts.length ?? 0) + (quorumVotes.get(interruptId)?.rejects.length ?? 0) + 1}`;
  return { outcome: tallyVote(interruptId, requiredApprovals, data.rejectionPolicy, rv.action, voter) };
}

/** Ledger bookkeeping shared by the ordinary-vote and override-as-one-vote
 *  paths. Returns the gate's post-vote disposition. */
function tallyVote(
  interruptId: string,
  requiredApprovals: number,
  rejectionPolicy: string | undefined,
  action: 'accept' | 'reject',
  voter: string,
): 'accept-quorum-met' | 'reject-majority' | 'pending' {
  let ledger = quorumVotes.get(interruptId);
  if (!ledger) {
    ledger = { accepts: [], rejects: [] };
    quorumVotes.set(interruptId, ledger);
  }
  if (action === 'accept') ledger.accepts.push(voter);
  else ledger.rejects.push(voter);

  // Resolution checks.
  if (ledger.accepts.length >= requiredApprovals) return 'accept-quorum-met';
  if (rejectionPolicy === 'majority') {
    // Majority rejection = more than half of requiredApprovals
    // rejected. For requiredApprovals=3, majority-reject = 2 rejects.
    const majorityThreshold = Math.floor(requiredApprovals / 2) + 1;
    if (ledger.rejects.length >= majorityThreshold) return 'reject-majority';
  }
  return 'pending';
}

function clearQuorumVotes(interruptId: string): void {
  quorumVotes.delete(interruptId);
}

/** Test-only seam: awaits the per-run resume chain so a regression
 *  test can deterministically wait for all chained resumes to settle
 *  without sleeping. Returns immediately when no resumes are pending
 *  for `runId`. Not part of the public route surface. */
export async function __awaitRunResumeChainForTests(runId: string): Promise<void> {
  // Re-poll: the chain entry mutates as each chained resume settles
  // and clears itself, so awaiting one entry is not enough — the
  // .finally() may swap in a fresh tail.
  for (;;) {
    const tail = runResumeChains.get(runId);
    if (!tail) return;
    await tail;
    // Loop: a sibling resume scheduled mid-await would have replaced
    // `tail` in the map. Re-check until the map is empty.
  }
}

/** Test-only seam: exports `resolveAndResume` for regression coverage
 *  of the per-run serialization fix. Production callers go through
 *  the registered HTTP routes above. */
export const __resolveAndResumeForTests = (
  storage: Storage,
  hostSuite: HostAdapterSuite,
  interruptId: string,
  resumeValue: unknown,
): Promise<void> => resolveAndResume(storage, hostSuite, interruptId, resumeValue);

async function resolveAndResume(
  storage: Storage,
  hostSuite: HostAdapterSuite,
  interruptId: string,
  resumeValue: unknown,
): Promise<void> {
  const interrupt = await storage.getInterrupt(interruptId);
  if (!interrupt) throw new OpenwopError('interrupt_not_found', 'interrupt missing on resume', 404);

  // Quorum-gate handling: accumulate votes until threshold met.
  // Returns null when not a quorum gate (fall-through to normal resume).
  const quorumResult = recordQuorumVote(interruptId, interrupt.data, resumeValue);
  const quorumOutcome = quorumResult?.outcome ?? null;
  // RFC 0093 §D.2 — the override path (whether it bypassed quorum or counted
  // as one vote) MUST emit `approval.overridden { principal, reason }` AND
  // write an audit-log entry.
  if (quorumResult?.override) {
    await getEventLog().append({
      runId: interrupt.runId,
      nodeId: interrupt.nodeId,
      type: 'approval.overridden',
      payload: {
        interruptId,
        principal: quorumResult.override.principal,
        reason: quorumResult.override.reason,
        bypassedQuorum: quorumOutcome === 'accept-override',
      },
    });
    hostSuite.auditSink.record({
      principalId: quorumResult.override.principal,
      action: 'approval.override',
      resource: `interrupt:${interruptId}`,
      outcome: 'success',
      payload: {
        runId: interrupt.runId,
        nodeId: interrupt.nodeId,
        reason: quorumResult.override.reason,
        bypassedQuorum: quorumOutcome === 'accept-override',
      },
    });
  }
  if (quorumOutcome === 'pending') {
    // Vote recorded but quorum not met. Emit a partial-vote event so
    // callers polling the event log can see the progress. The
    // interrupt stays open; the run stays in waiting-approval.
    await getEventLog().append({
      runId: interrupt.runId,
      nodeId: interrupt.nodeId,
      type: 'interrupt.vote.recorded',
      payload: { interruptId, kind: interrupt.kind, ledger: quorumVotes.get(interruptId) },
    });
    return;
  }
  if (quorumOutcome === 'reject-majority') {
    clearQuorumVotes(interruptId);
    // Fail the gate. Mark interrupt resolved with the rejection,
    // then mark the run failed. We don't resume execution.
    await storage.resolveInterrupt(interruptId, { action: 'reject', reason: 'quorum-majority-reject' }, new Date().toISOString());
    await getEventLog().append({
      runId: interrupt.runId,
      nodeId: interrupt.nodeId,
      type: 'run.failed',
      payload: {
        error: { code: 'approval_rejected', message: 'Quorum gate failed: majority rejected.' },
      },
    });
    await storage.updateRun(interrupt.runId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: { code: 'approval_rejected', message: 'Quorum gate failed: majority rejected.' },
    });
    return;
  }
  if (quorumOutcome === 'accept-quorum-met' || quorumOutcome === 'accept-override') {
    clearQuorumVotes(interruptId);
    // Fall through to the normal resume path below.
  }

  await getSuspendManager().resolve(interruptId, resumeValue);
  await getEventLog().append({
    runId: interrupt.runId,
    nodeId: interrupt.nodeId,
    type: 'node.interrupt.resolved',
    payload: { interruptId, kind: interrupt.kind },
  });

  // Synchronous validation (preserves the pre-existing 404 / 500
  // behaviour on the HTTP response path). These reads aren't racy —
  // they only check existence, not the snapshot. The *snapshot*
  // read moves into the chained block below.
  const run = await storage.getRun(interrupt.runId);
  if (!run) throw new OpenwopError('run_not_found', `run ${interrupt.runId} missing during resume`, 404);
  const wf = await hostSuite.workflowCatalog.getWorkflow(run.workflowId);
  if (!wf) throw new OpenwopError('workflow_not_found', `workflow ${run.workflowId} not found`, 404);
  const nodeIndex = wf.definition.nodes.findIndex((n) => n.nodeId === interrupt.nodeId);
  if (nodeIndex < 0) throw new OpenwopError('internal_error', `suspended node ${interrupt.nodeId} not in workflow`, 500);

  // Per-run resume serialization. Concurrent resolves of *parallel*
  // suspended interrupts (e.g. a fan-out workflow where 4 approval
  // nodes all suspend on the same run, then the user approves all
  // four in quick succession) used to race on the persisted
  // `schedulerSnapshot`:
  //
  //   1. Each call read `run.schedulerSnapshot` at API time,
  //      capturing the same stale snapshot in which *all four*
  //      approvals are still suspended.
  //   2. Each call scheduled its own `executeRun` via setImmediate.
  //      The four executors ran concurrently — each one hydrated
  //      from the captured stale snapshot, marked *only its own*
  //      resumed node `completed`, drained, and persisted.
  //   3. Each persist overwrote the previous one. Net effect: only
  //      the *last* executor's view (one resume) survived in the
  //      stored snapshot. The other three resumes emitted
  //      `node.interrupt.resolved` but never reached `run.resumed`
  //      / `node.completed` — silently dropped.
  //
  // Symptom in the event log: 4 × `node.interrupt.resolved`, but
  // only 1-2 × `run.resumed` + `node.completed`. The user-facing
  // chat shows the workflow stuck at "Running" forever.
  //
  // Fix: chain the snapshot read + executor dispatch behind any
  // pending resume on the *same* runId so each resume hydrates from
  // the freshest persisted snapshot. The HTTP response still
  // returns immediately (we don't await `next` here) — only the
  // background executor work serializes.
  const prevChain = runResumeChains.get(interrupt.runId) ?? Promise.resolve();
  const next: Promise<void> = prevChain.then(async () => {
    // Re-read the run AFTER the previous resume's executor has
    // fully settled and persisted its snapshot. This is what fixes
    // the race — pre-chain, every concurrent resume read the same
    // pre-any-resume snapshot.
    const freshRun = await storage.getRun(interrupt.runId);
    if (!freshRun) {
      log.warn('resume skipped — run record vanished between resolve + execute', {
        runId: interrupt.runId,
      });
      return;
    }
    // Resume the DAG scheduler. If a serialized snapshot exists
    // (post-DAG), hydrate it and mark the suspended node as
    // completed with the resolved value. If not (legacy linear
    // path), fall back to `resumeFromNodeIndex` which the executor
    // handles via its implicit-linear chain logic.
    const serializedSnapshot = freshRun.schedulerSnapshot;
    // ctx.suspend/ctx.interrupt nodes tag the interrupt for re-invoke resume
    // (the node re-runs to shape the resolution into its outputs); native
    // return-and-resume nodes use the default mark-completed path.
    const idata = (interrupt.data ?? {}) as { __resumeStyle?: unknown; __resumeKey?: unknown };
    const reinvokeOpts = idata.__resumeStyle === 'reinvoke'
      ? { resumeStyle: 'reinvoke' as const, ...(typeof idata.__resumeKey === 'string' ? { resumeKey: idata.__resumeKey } : {}) }
      : {};
    const resumeOptions =
      typeof serializedSnapshot === 'string'
        ? (() => {
            try {
              return {
                resumeSnapshot: JSON.parse(serializedSnapshot) as never,
                resumeNodeId: interrupt.nodeId,
                resumeValue,
                ...reinvokeOpts,
                policyResolver: hostSuite.providerPolicyResolver,
              };
            } catch {
              return {
                resumeFromNodeIndex: nodeIndex + 1,
                resumeValue,
                policyResolver: hostSuite.providerPolicyResolver,
              };
            }
          })()
        : {
            resumeFromNodeIndex: nodeIndex + 1,
            resumeValue,
            policyResolver: hostSuite.providerPolicyResolver,
          };
    // AWAIT here — the chain's whole purpose is that the next
    // resume's snapshot read sees this executor's persist.
    await executeRun(storage, freshRun, wf.definition, resumeOptions);
  }).catch((err) => {
    log.error('resume dispatch failed', {
      runId: interrupt.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }).finally(() => {
    // Only clear if we're still the tail — a subsequent resolve may
    // have chained another resume onto us. Clearing then would
    // strand the chain entry, and the next concurrent resolve
    // would start a fresh unserialized chain that races with us.
    if (runResumeChains.get(interrupt.runId) === next) {
      runResumeChains.delete(interrupt.runId);
    }
  });
  runResumeChains.set(interrupt.runId, next);
}
