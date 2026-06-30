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
import { startWorkflowRun } from '../host/runStarter.js';
import { AGENT_MENTION_WORKFLOW_ID, agentMentionConfigurable } from '../host/agentMentionWorkflows.js';
import { appendDecision, tallyDecisions, clearDecisions, evaluateQuorumTally, type DecisionOutcome } from '../host/reviewDecisionLedger.js';
import { resolveEffectiveAccess } from '../host/accessControlService.js';
import { isEligibleApprover } from '../host/approverResolution.js';
import { requireProtocolScope } from '../host/protocolAuthorization.js';
import { emitReviewUpdatedSignal } from '../notifications/notify.js';

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
      // RFC 0049 (ADR 0006 Phase 3) — resolving a run's interrupt exposes run
      // state, so gate on `runs:read` exactly as `GET /v1/runs/:runId` and the
      // unified `/reviews` action route do. No-op unless the host enforces
      // scopes; when it does, this is the access floor for the node route (the
      // only resolve path that previously lacked it). Quorum eligibility +
      // capability-token checks still apply below.
      await requireProtocolScope(req, 'runs:read');
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
          // ADR 0089 — inject the provider policy resolver so a tool-bearing
          // @mentioned agent can run its tool loop (the loop's adapter needs it).
          {
            policyResolver: hostSuite.providerPolicyResolver,
            // ADR 0089 Phase 4 (Option B) — dispatch a deep-investigation
            // @mentioned agent's tool loop as a SEPARATE persisted run via the
            // standard run path (the synthetic `openwop-app.agent-mention`
            // workflow). The conversation embeds it as a `workflow_run` bubble.
            startAgentMentionRun: ({ tenantId, agentId, task, provider, model, credentialRef, metadata }) => {
              // BYOK fix (review): a non-managed credentialRef must be REGISTERED in
              // `configurable.credentialRefs` so `prepareRunSecrets` resolves it into the
              // nested run's secret scope (the adapter's resolveCredential reads it).
              // Passing it only via `inputs` left BYOK deep-investigation runs throwing
              // `byok_required_but_unresolved`.
              const configurable = agentMentionConfigurable(credentialRef);
              return startWorkflowRun(
                { storage, hostSuite },
                {
                  tenantId,
                  workflowId: AGENT_MENTION_WORKFLOW_ID,
                  inputs: {
                    agentId,
                    task,
                    ...(provider ? { provider } : {}),
                    ...(model ? { model } : {}),
                    ...(credentialRef ? { credentialRef } : {}),
                  },
                  ...(Object.keys(configurable).length > 0 ? { configurable } : {}),
                  ...(metadata ? { metadata } : {}),
                },
              );
            },
          },
        );
        const cRun = await storage.getRun(runId);
        res.json({ runId, nodeId, status: cRun?.status ?? 'waiting-input', conversation: { operation: result.operation, turns: result.turns.length } });
        return;
      }
      const body = req.body as ResolveInterruptRequest;
      validateResumeValue(interrupt, body?.resumeValue);
      // ADR 0070 — the vote identity is the authenticated USER session
      // (`req.userId`): we pin it (eligibility-enforced) and IGNORE the client
      // `voter` field (anti-spoofing). A bare API-key / bearer principal with NO
      // user session is the RFC 0093 capability-token transport — the token
      // authorizes ACCESS, and the body `voter` declares WHICH approver (distinct
      // voters on one token), so we DON'T pin the single principal id (that would
      // dedup every token vote into one). An anon cookie session (no `userId`,
      // `session:`/`anon:` principal) is NEITHER — it fails closed on a quorum
      // gate (see `assertTokenQuorumVote`); the API-key path sets a `bearer:`
      // principal id (middleware/auth.ts).
      const reviewerRef = req.userId;
      const isCapabilityToken = !reviewerRef && (req.principal?.principalId?.startsWith('bearer:') ?? false);
      await resolveAndResume(
        storage,
        hostSuite,
        interrupt.interruptId,
        body?.resumeValue,
        reviewerRef ? { subjectRef: reviewerRef } : { capabilityToken: isCapabilityToken },
      );
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
      // The URL token was cryptographically matched to THIS interrupt — the RFC
      // 0093 capability-token path (the token is the authorization; body `voter`
      // declares the approver, approverRefs-constrained in `assertTokenQuorumVote`).
      await resolveAndResume(storage, hostSuite, interrupt.interruptId, body?.resumeValue, { capabilityToken: true });
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
// Exported (ADR 0068) so the unified /reviews action surface validates an
// interrupt resume through the SAME contract the interrupt routes use.
export function validateResumeValue(
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

// Quorum votes live in the DURABLE `review:decision` ledger (ADR 0070 —
// host/reviewDecisionLedger.ts), keyed `(interruptId, reviewerRef)`, so they
// survive restart, are correct across instances, and dedup per reviewer. The
// final gate transition stays the `storage.resolveInterrupt` CAS (one winner).

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
  outcome: 'accept-quorum-met' | 'reject-quorum' | 'pending' | 'accept-override';
  override?: { principal: string; reason: string };
}

/** Accumulate a quorum vote. Returns:
 *   - outcome 'accept-quorum-met' → run can resume with accepted outcome
 *   - outcome 'accept-override' → an override principal bypassed quorum
 *     (only when the gate config sets `overrideBypassesQuorum: true` —
 *     RFC 0093 §D.2; default false ⇒ the override counts as ONE vote)
 *   - outcome 'reject-quorum' → gate fails with rejection (per the gate's
 *     rejectionPolicy: 'any' default ⇒ one reject vetoes; 'majority' ⇒ > half)
 *   - outcome 'pending' → record vote, return 200 to client, DON'T resume
 *   - null → not a quorum gate; caller proceeds with normal resume */
async function recordQuorumVote(
  interruptId: string,
  interruptData: unknown,
  resumeValue: unknown,
  reviewerRef: string | undefined,
): Promise<QuorumVoteResult | null> {
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

  // The vote IDENTITY (ADR 0070): the authenticated reviewer when present;
  // otherwise the legacy client `voter` (the signed-token path, where the token
  // is the capability) or an anon counter. NEVER trust `voter` over an
  // authenticated reviewer — eligibility was already enforced upstream.
  const tally = await tallyDecisions(interruptId);
  const fallbackVoter = typeof rv.voter === 'string' ? rv.voter : `anon-${tally.accepts.length + tally.rejects.length + 1}`;
  const voter = reviewerRef ?? fallbackVoter;

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
    const override = { principal: voter, reason: rv.reason };
    if (data.overrideBypassesQuorum === true) {
      // Opt-in bypass: a single override accept resolves the gate. Record the
      // decision (audited as an override) before resolving.
      await appendDecision({ gateId: interruptId, reviewerRef: voter, outcome: 'override_approved', reason: rv.reason, decidedAt: new Date().toISOString() });
      return { outcome: 'accept-override', override };
    }
    // Default (false/absent): the override grant counts as ONE quorum vote —
    // recorded as `override_approved` so it is auditable as an override.
    const outcome = await tallyVote(interruptId, requiredApprovals, data.rejectionPolicy, 'override_approved', voter, rv.reason);
    return { outcome, override };
  }

  if (rv.action !== 'accept' && rv.action !== 'reject') return null;
  const outcome: DecisionOutcome = rv.action === 'accept' ? 'approved' : 'rejected';
  return { outcome: await tallyVote(interruptId, requiredApprovals, data.rejectionPolicy, outcome, voter) };
}

/** Append the reviewer's decision to the DURABLE ledger (overwrite-by-reviewer =
 *  dedup), then evaluate the gate over the full ledger. The final transition
 *  itself stays the `storage.resolveInterrupt` CAS in `resolveAndResume`. */
async function tallyVote(
  interruptId: string,
  requiredApprovals: number,
  rejectionPolicy: string | undefined,
  outcome: DecisionOutcome,
  voter: string,
  reason?: string,
): Promise<'accept-quorum-met' | 'reject-quorum' | 'pending'> {
  await appendDecision({ gateId: interruptId, reviewerRef: voter, outcome, ...(reason ? { reason } : {}), decidedAt: new Date().toISOString() });
  const tally = await tallyDecisions(interruptId);
  // Single source of truth for the threshold + rejection math (ADR 0070).
  const verdict = evaluateQuorumTally(tally, {
    requiredApprovals,
    rejectionPolicy: rejectionPolicy === 'majority' ? 'majority' : 'any',
  });
  if (verdict === 'accept') return 'accept-quorum-met';
  if (verdict === 'reject') return 'reject-quorum';
  return 'pending';
}

async function clearQuorumVotes(interruptId: string): Promise<void> {
  await clearDecisions(interruptId);
}

/**
 * Eligibility gate (ADR 0070) — enforced ONLY when the host knows the
 * authenticated reviewer (the token path stays capability-based). A vote is
 * accepted iff the reviewer is on the gate's explicit `approverRefs`; a gate
 * with NO explicit approver list is an OPEN quorum gate (any authenticated
 * reviewer may vote — the gate counts distinct identities, deduped by subject).
 * An OVERRIDE additionally requires one of the gate's `overrideScopes`.
 * Visible-but-ineligible → 403 (the route already 404s a non-visible interrupt).
 *
 * **Why empty-list = open (not scope-gated).** The `openwop-interrupt-quorum`
 * profile (`interrupt-profiles.md`) is pure vote-COUNTING to a threshold +
 * `rejectionPolicy`; per-subject AUTHORIZATION is the SEPARATE
 * `openwop-interrupt-auth-required` profile. The conformance fixture
 * `conformance-interrupt-quorum` (empty `approversList`, three voters, an
 * API-key caller) asserts an open gate accepts votes; requiring an
 * `approvals:respond` scope here previously 403'd that scenario and blocked the
 * (honest) discovery claim. An empty-list gate is still far stronger than the
 * pre-0070 in-memory `voter`-from-body counter (real identity, no spoofing,
 * durable dedup); authors who want an ACL set `approverRefs`.
 *
 * NOTE — the pre-execution **approval** quorum path (`host/approvalDecision.ts`
 * `evaluateQuorum`) DELIBERATELY differs: there an empty list still requires the
 * `approvals:respond` scope (higher-stakes, no conformance obligation). The two
 * are intentionally asymmetric; keep them that way.
 */
async function assertEligibleApprover(
  storage: Storage,
  interrupt: InterruptRecord,
  reviewerRef: string,
  resumeValue: unknown,
): Promise<void> {
  const data = (interrupt.data ?? {}) as { requiredApprovals?: number; approverRefs?: unknown; approversList?: unknown; approverGroupRefs?: unknown; approverRoleRefs?: unknown; overrideScopes?: unknown };
  const requiredApprovals = typeof data.requiredApprovals === 'number' && data.requiredApprovals > 1 ? data.requiredApprovals : 0;
  if (requiredApprovals === 0) return; // not a quorum gate — no eligibility gate
  const run = await storage.getRun(interrupt.runId);
  const tenantId = run?.tenantId ?? 'default';
  const access = await resolveEffectiveAccess(tenantId, { subject: reviewerRef });

  const rv = (resumeValue ?? {}) as { action?: string; override?: unknown };
  const isOverride = rv.action === 'override' || (rv.action === 'accept' && rv.override === true);
  const overrideScopes = Array.isArray(data.overrideScopes) ? data.overrideScopes.filter((s): s is string => typeof s === 'string') : [];
  if (isOverride && overrideScopes.length > 0) {
    if (!overrideScopes.some((s) => (access.scopes as readonly string[]).includes(s))) {
      throw new OpenwopError('forbidden', 'Override requires one of the gate\'s override scopes.', 403, { interruptId: interrupt.interruptId });
    }
    return;
  }
  // Eligibility (ADR 0075 §D1) — explicit subjects (`approverRefs`, or the legacy
  // `approversList`) ∪ group members ∪ role holders, resolved through the single
  // approver authority against the run's fail-closed org (`run.metadata.approverOrgId`,
  // §D3) and CANONICALIZED to userIds so a group member's `oidc:` subject matches
  // the bound-user reviewer's userId (§D6). An empty set ⇒ open quorum gate (any
  // authenticated reviewer may vote — the `openwop-interrupt-quorum` contract).
  const subjects = (Array.isArray(data.approverRefs) ? data.approverRefs : Array.isArray(data.approversList) ? data.approversList : [])
    .filter((r): r is string => typeof r === 'string');
  const groupRefs = Array.isArray(data.approverGroupRefs) ? data.approverGroupRefs.filter((r): r is string => typeof r === 'string') : [];
  const roleRefs = Array.isArray(data.approverRoleRefs) ? data.approverRoleRefs.filter((r): r is string => typeof r === 'string') : [];
  const approverOrgId = (run?.metadata as Record<string, unknown> | undefined)?.approverOrgId;
  const { eligible, openGate } = await isEligibleApprover(
    reviewerRef,
    { approverRefs: subjects, approverGroupRefs: groupRefs, approverRoleRefs: roleRefs },
    { tenantId, ...(typeof approverOrgId === 'string' ? { orgId: approverOrgId } : {}) },
  );
  if (!openGate && !eligible) {
    throw new OpenwopError('forbidden', 'You are not an eligible approver for this gate.', 403, { interruptId: interrupt.interruptId });
  }
}

/**
 * Quorum eligibility for a caller with NO bound user identity (ADR 0070). Two
 * cases for a quorum gate (`requiredApprovals > 1`):
 *   - `isCapabilityToken` (a signed RFC 0093 interrupt token, or a bearer /
 *     API-key principal): the token IS the authorization, and its body `voter`
 *     declares the approver. When the gate lists explicit approvers, that `voter`
 *     MUST be one of them — otherwise a single token could satisfy a restricted
 *     N-approver gate with fabricated voter ids. An OPEN gate (empty list) admits
 *     any `voter`, matching the `openwop-interrupt-quorum` conformance contract.
 *   - otherwise (anon cookie session / no principal): a quorum vote fails closed
 *     — the node route has no per-run owner check, so eligibility is the only
 *     authorization on this path, and an anonymous caller is not an approver.
 * No-op for a non-quorum interrupt (the clarification / single-approver / token
 * resume paths are unchanged).
 */
function assertTokenQuorumVote(interrupt: InterruptRecord, resumeValue: unknown, isCapabilityToken: boolean): void {
  const data = (interrupt.data ?? {}) as { requiredApprovals?: number; approverRefs?: unknown; approversList?: unknown };
  const requiredApprovals = typeof data.requiredApprovals === 'number' && data.requiredApprovals > 1 ? data.requiredApprovals : 0;
  if (requiredApprovals === 0) return; // not a quorum gate
  if (!isCapabilityToken) {
    throw new OpenwopError('forbidden', 'Voting on a quorum gate requires an authenticated approver or a valid interrupt token.', 403, { interruptId: interrupt.interruptId });
  }
  const explicit = Array.isArray(data.approverRefs) ? data.approverRefs : Array.isArray(data.approversList) ? data.approversList : [];
  const approverRefs = explicit.filter((r): r is string => typeof r === 'string');
  if (approverRefs.length === 0) return; // open gate — any voter id is admissible
  const rv = (resumeValue ?? {}) as { voter?: unknown };
  const voter = typeof rv.voter === 'string' ? rv.voter : undefined;
  if (!voter || !approverRefs.includes(voter)) {
    throw new OpenwopError('forbidden', 'The `voter` is not an eligible approver for this gate.', 403, { interruptId: interrupt.interruptId });
  }
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
 *  the registered HTTP routes above. Resolves as the RFC 0093 capability-token
 *  path (the signed-token route's posture), which these tests simulate. */
export const __resolveAndResumeForTests = (
  storage: Storage,
  hostSuite: HostAdapterSuite,
  interruptId: string,
  resumeValue: unknown,
): Promise<void> => resolveAndResume(storage, hostSuite, interruptId, resumeValue, { capabilityToken: true });

// Exported (ADR 0068) so the unified /reviews action surface resolves an
// interrupt through the SAME quorum/resume/replay path as the interrupt routes —
// the projection never re-implements resume.
export async function resolveAndResume(
  storage: Storage,
  hostSuite: HostAdapterSuite,
  interruptId: string,
  resumeValue: unknown,
  reviewer?: { subjectRef?: string; capabilityToken?: boolean },
): Promise<void> {
  const interrupt = await storage.getInterrupt(interruptId);
  if (!interrupt) throw new OpenwopError('interrupt_not_found', 'interrupt missing on resume', 404);

  // ADR 0074 — broadcast a `review.updated` cache hint at each terminal outcome
  // so every live review surface reconciles. The interrupt record carries no
  // tenant, so resolve it from the run (a keyed point lookup). Best-effort: the
  // helper swallows emission failures (a cache hint must not break a resume).
  const signalReview = async (
    status: string,
    policy?: { requiredApprovals: number; approvals: number; rejections: number },
  ): Promise<void> => {
    const ownerRun = await storage.getRun(interrupt.runId);
    // Fail closed: without a run we can't determine the tenant, so don't
    // broadcast (the cache hint is best-effort, and an orphaned interrupt has
    // no live surface to update anyway).
    if (!ownerRun) return;
    emitReviewUpdatedSignal({
      tenantId: ownerRun.tenantId,
      reviewId: `interrupt:${interruptId}`,
      status,
      runId: interrupt.runId,
      nodeId: interrupt.nodeId,
      interruptId,
      ...(policy ? { policy } : {}),
    });
  };

  // ADR 0070 — gate a quorum vote on WHO is voting, in three tiers:
  //   (a) a bound authenticated USER (`subjectRef`): pin the identity and enforce
  //       `assertEligibleApprover` (approverRefs membership / approvals:respond);
  //   (b) an RFC 0093 CAPABILITY TOKEN (a signed interrupt token, or a bearer /
  //       API-key principal with no bound user): the token authorizes access and
  //       the body `voter` declares the approver — but it MUST name a listed
  //       approver when the gate declares an explicit list (`assertTokenQuorumVote`);
  //   (c) anon / no identity: a quorum vote fails closed.
  // (Non-quorum interrupts — clarification, single-approver, conversation — are
  // untouched: both helpers no-op when `requiredApprovals <= 1`.)
  const reviewerRef = reviewer?.subjectRef;
  if (reviewerRef) await assertEligibleApprover(storage, interrupt, reviewerRef, resumeValue);
  else await assertTokenQuorumVote(interrupt, resumeValue, reviewer?.capabilityToken === true);

  // Quorum-gate handling: accumulate votes (durable ledger) until threshold met.
  // Returns null when not a quorum gate (fall-through to normal resume).
  const quorumResult = await recordQuorumVote(interruptId, interrupt.data, resumeValue, reviewerRef);
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
    const ledger = await tallyDecisions(interruptId);
    await getEventLog().append({
      runId: interrupt.runId,
      nodeId: interrupt.nodeId,
      type: 'interrupt.vote.recorded',
      payload: { interruptId, kind: interrupt.kind, ledger },
    });
    // ADR 0074 — still pending; broadcast the updated quorum progress so other
    // surfaces re-render the counts without a full refetch.
    const required = (interrupt.data as { requiredApprovals?: number } | null)?.requiredApprovals;
    await signalReview('pending', typeof required === 'number'
      ? { requiredApprovals: required, approvals: ledger.accepts.length, rejections: ledger.rejects.length }
      : undefined);
    return;
  }
  if (quorumOutcome === 'reject-quorum') {
    await clearQuorumVotes(interruptId);
    // Fail the gate. Mark interrupt resolved with the rejection,
    // then mark the run failed. We don't resume execution.
    await storage.resolveInterrupt(interruptId, { action: 'reject', reason: 'quorum-reject' }, new Date().toISOString());
    await getEventLog().append({
      runId: interrupt.runId,
      nodeId: interrupt.nodeId,
      type: 'run.failed',
      payload: {
        error: { code: 'approval_rejected', message: 'Quorum gate failed: rejected.' },
      },
    });
    await storage.updateRun(interrupt.runId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: { code: 'approval_rejected', message: 'Quorum gate failed: rejected.' },
    });
    await signalReview('rejected'); // ADR 0074 — gate failed; surfaces clear the card
    return;
  }
  if (quorumOutcome === 'accept-quorum-met' || quorumOutcome === 'accept-override') {
    await clearQuorumVotes(interruptId);
    // Fall through to the normal resume path below.
  }

  await getSuspendManager().resolve(interruptId, resumeValue);
  await getEventLog().append({
    runId: interrupt.runId,
    nodeId: interrupt.nodeId,
    type: 'node.interrupt.resolved',
    payload: { interruptId, kind: interrupt.kind },
  });
  await signalReview('resolved'); // ADR 0074 — review resolved; surfaces mark it done

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
