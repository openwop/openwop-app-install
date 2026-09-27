/**
 * RFC 0151 conformance test seams — `host-sample-test-seams.md` §21.
 *
 *   POST /v1/host/sample/test/compensation/unwind  { nodes?: 1..8, fail?: boolean }
 *     → 200 { runId, events, compensatedOrder }
 *   POST /v1/host/sample/test/compensation/replay  {}
 *     → 200 { runId, refiredEffects }
 *
 * WHY THESE SEAMS HAVE TO EXIST. §C's rules — the plan persisted before the
 * first inverse action, descending forward-completion order, replay that does
 * not re-fire — are host-internal and unobservable from a normal run's wire
 * except as the relative order of `compensation.*` events, which no black-box
 * scenario can provoke without an effect that fails on cue. RFC 0148 §A
 * resolves an unobservable requirement to `blocked`, so without these the
 * profile cannot be certified at all.
 *
 * NON-VACUITY IS THE WHOLE POINT, and §21 states it as a MUST: these "MUST NOT
 * be a mock that returns a canned event list: the executor, plan persistence,
 * and ordering must be the ones the production failure path uses, or the
 * witness proves nothing."
 *
 * So this route builds a real workflow of real registered node modules, inserts
 * a real run, and calls the real `executeRun`. The unwind that follows is the
 * one `finalizeRun`'s failed branch drives on any production failure — this
 * file contains no ordering logic, no plan, and no event emission of its own.
 * `compensatedOrder` is read from what the fake INVERSE node recorded as it
 * executed, so it reports what happened rather than what was scheduled.
 *
 * The only thing the seam supplies is determinism: fake effects that commit
 * without leaving the process, and a last node that fails on cue.
 *
 * Gated on `OPENWOP_TEST_SEAM_ENABLED=true` (OFF by default), the standard
 * `/v1/host/sample/*` posture per `host-sample-test-seams.md` §"Production
 * safety" — production deployments keep it 404.
 *
 * NOTE ON THE CAPABILITY GATE. §21's gate is `compensation.supported: true`,
 * which this host does NOT advertise yet (ADR 0554 P2 ships the behaviour, and
 * the advert lands with `compensationStatus` on the snapshot and the removal of
 * the `openwop-compensation` opt-out, in one commit). The seam is wired anyway
 * so the behaviour has a witness to run against the moment the pair flips —
 * shipping the advert and the seam separately is how a capability gets claimed
 * a release before anything can check it.
 *
 * @see spec/v1/compensation.md · spec/v1/host-sample-test-seams.md §21
 * @see docs/adr/0554-compensation-saga-and-operator-recovery-runtime.md
 */

import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { Storage } from '../storage/storage.js';
import type { NodeModule, WorkflowDefinition } from '../executor/types.js';
import type { RunRecord } from '../types.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { insertRunWithStartContext } from '../host/runInsert.js';
import { assertEffectAllowed } from '../host/runEffectContext.js';
import { createLogger } from '../observability/logger.js';
import {
  COMPENSATION_OPERATOR_ACTIONS,
  applyOperatorDisposition,
  decideCompensationOperatorAction,
  type CompensationOperatorAction,
} from '../host/compensationOperator.js';
import { sendError } from '../middleware/errorEnvelope.js';

const log = createLogger('routes.compensation-seam');

const SEAM_PATHS = [
  '/v1/host/openwop-app/test/compensation',
  '/v1/host/sample/test/compensation',
] as const;

/** The seam's deterministic fake effect pair. Namespaced under the host
 *  extension prefix so they can never collide with a real pack. */
const FORWARD_TYPE = 'openwop-app.test.compensation.commit';
const INVERSE_TYPE = 'openwop-app.test.compensation.undo';
const FAIL_TYPE = 'openwop-app.test.compensation.fail';

/**
 * What the fake effects recorded, per run.
 *
 * `inverses` is the non-vacuity evidence §21 requires: it is appended by the
 * INVERSE node as it executes, so it is the order the inverse actions actually
 * ran in. A `compensatedOrder` derived from the plan instead would stay
 * descending even if the executor ran the plan backwards.
 */
interface SeamLedger {
  forwards: number[];
  inverses: number[];
  /**
   * §21 recovery extension — the idempotency key the FAKE DOWNSTREAM received on
   * each inverse attempt, in order, keyed by the forward ordinal.
   *
   * This is the non-vacuity evidence for §C's retry-stability rule, and it has
   * to be recorded HERE rather than reported by the host: the host knows what
   * key it INTENDED to present, and the only thing that can witness what was
   * actually presented is the thing on the receiving end. A host-reported key
   * would be the host marking its own homework.
   */
  downstreamKeys: Map<number, string[]>;
  /** Remaining transient failures to inject into the first inverse to run. */
  failFirst: number;
  /** §21 `hold: true` — the first inverse fails PERMANENTLY. */
  hold: boolean;
  /** The ordinal the fault applies to (the first inverse that runs). */
  faultOrdinal: number | null;
}
const seamLedgers = new Map<string, SeamLedger>();
/** Bounded: the scenario reads its run seconds after starting it. */
const MAX_TRACKED = 256;

function ledgerFor(runId: string): SeamLedger {
  let entry = seamLedgers.get(runId);
  if (!entry) {
    entry = { forwards: [], inverses: [], downstreamKeys: new Map(), failFirst: 0, hold: false, faultOrdinal: null };
    seamLedgers.set(runId, entry);
    while (seamLedgers.size > MAX_TRACKED) {
      const oldest = seamLedgers.keys().next();
      if (oldest.done) break;
      seamLedgers.delete(oldest.value);
    }
  }
  return entry;
}

function ordinalOf(inputs: unknown): number {
  const n = (inputs as { ordinal?: unknown } | null)?.ordinal;
  return typeof n === 'number' ? n : 0;
}

/**
 * The forward effect. It calls `assertEffectAllowed` for real, so it is counted
 * by the ADR 0533 escape counter, classified by the ADR 0554 observer, and
 * fails closed during a replay exactly like a production sender — the three
 * behaviours the witness is here to prove are wired.
 */
const FORWARD_NODE: NodeModule = {
  typeId: FORWARD_TYPE,
  version: '1.0.0',
  sideEffecting: true,
  async execute(ctx) {
    assertEffectAllowed('network-egress', `compensation seam forward ${ctx.nodeId}`);
    const ordinal = ordinalOf(ctx.inputs);
    ledgerFor(ctx.runId).forwards.push(ordinal);
    return { status: 'success', outputs: { ordinal, committed: true } };
  },
};

/** The inverse effect. Also a real guarded effect (P0 finding 2: compensation
 *  is itself an effect), and the recorder for `compensatedOrder`. */
const INVERSE_NODE: NodeModule = {
  typeId: INVERSE_TYPE,
  version: '1.0.0',
  sideEffecting: true,
  async execute(ctx) {
    assertEffectAllowed('network-egress', `compensation seam inverse ${ctx.nodeId}`);
    const ordinal = ordinalOf(ctx.inputs);
    const ledger = ledgerFor(ctx.runId);

    // §21 / RFC 0151 §C — record the key THIS ATTEMPT presented, as the fake
    // downstream received it. `ctx.compensation.inverseActionId` is the host's
    // §C identity, handed to the compensator precisely so it can be used as the
    // idempotency key; a compensator that instead composed the attempt in would
    // produce a different key per retry, and this recorder is what would catch
    // it. The `??` fallback is a DELIBERATE canary: if the host ever stops
    // threading the identity, the recorded keys become per-attempt distinct and
    // the retry-stability leg fails loudly, instead of the seam quietly
    // substituting a stable value the host never presented.
    const key = ctx.compensation?.inverseActionId ?? `UNTHREADED-attempt-${ctx.attempt}`;
    const keys = ledger.downstreamKeys.get(ordinal) ?? [];
    keys.push(key);
    ledger.downstreamKeys.set(ordinal, keys);

    // §21 fault injection, applied to the FIRST inverse to run (the highest
    // forward ordinal under `reverse-completion`). The faults are the seam's
    // only contribution — the ordering, the retry budget, the identity and the
    // plan are all the real executor's.
    if (ledger.faultOrdinal === null) ledger.faultOrdinal = ordinal;
    if (ledger.faultOrdinal === ordinal) {
      if (ledger.hold) {
        // Fails PERMANENTLY ⇒ the real unwind records
        // `manual_intervention_required` and the §D fold reads `manual`.
        return {
          status: 'failure',
          error: { code: 'internal_error', message: 'compensation seam: held for operator intervention' },
          retryable: false,
        };
      }
      if (ledger.failFirst > 0) {
        ledger.failFirst -= 1;
        return {
          status: 'failure',
          error: { code: 'internal_error', message: 'compensation seam: transient inverse failure' },
          retryable: true,
        };
      }
    }

    ledger.inverses.push(ordinal);
    return { status: 'success', outputs: { undone: true } };
  },
};

/** Fails on cue, with no effect and no compensation declaration of its own —
 *  the trigger for the unwind of everything that committed before it. */
const FAIL_NODE: NodeModule = {
  typeId: FAIL_TYPE,
  version: '1.0.0',
  async execute() {
    return {
      status: 'failure',
      error: { code: 'internal_error', message: 'compensation seam: deliberate terminal failure' },
      retryable: false,
    };
  },
};

function ensureSeamNodesRegistered(): void {
  const registry = getNodeRegistry();
  for (const node of [FORWARD_NODE, INVERSE_NODE, FAIL_NODE]) {
    if (!registry.has(node.typeId)) registry.register(node);
  }
}

/**
 * `nodes` forward-committing nodes, each declaring its inverse per RFC 0151 §B,
 * then one node that fails.
 *
 * `inputMapping` carries only the ordinal — a RECORDED FACT (§B: inputs "MUST
 * derive from recorded facts… prompt or model regeneration MUST NOT construct a
 * compensation input during replay"). A literal authored alongside the node is
 * the strongest form of that: there is nothing to re-infer.
 */
function seamDefinition(nodeCount: number, maxAttempts: number, fail: boolean): WorkflowDefinition {
  const nodes: WorkflowDefinition['nodes'][number][] = [];
  for (let i = 1; i <= nodeCount; i++) {
    nodes.push({
      nodeId: `commit-${i}`,
      typeId: FORWARD_TYPE,
      inputs: { ordinal: i },
      compensation: {
        nodeTypeId: INVERSE_TYPE,
        inputMapping: { ordinal: i },
        // §21: with `failFirstInverseAttempts: n` the seam "MUST run it under
        // retry bounds of at least `n + 1` attempts so the unwind still
        // completes" — otherwise the witness would observe an exhaustion rather
        // than the retry-stability it is there to check.
        retry: { maxAttempts, backoffMs: 0 },
      },
    });
  }
  // §21 `fail` (default `true`). With `fail: false` the failing node is OMITTED
  // so the SAME compensator-declaring workflow runs to completion — that is the
  // point of the healthy-run leg: it asserts `unwind: none` against a run that
  // legitimately HAS a plan's worth of declarations and simply never needed one.
  // Dropping the compensation declarations instead would make the leg assert
  // `none` about a workflow that could never unwind, which is a different and
  // much weaker claim.
  if (fail) nodes.push({ nodeId: 'boom', typeId: FAIL_TYPE });
  // The workflowId carries the retry bound AND the fail flag: two seam calls
  // with different shapes are different definitions, and reusing one id would
  // let the first registration decide the second call's behaviour.
  return {
    workflowId: `openwop-app.test.compensation.${nodeCount}x${maxAttempts}${fail ? '' : '.healthy'}`,
    nodes,
  };
}

async function runSeamWorkflow(
  storage: Storage,
  tenantId: string,
  nodeCount: number,
  fault: { failFirst?: number; hold?: boolean; fail?: boolean } = {},
): Promise<{ run: RunRecord; definition: WorkflowDefinition }> {
  ensureSeamNodesRegistered();
  const failFirst = Math.max(0, Math.trunc(fault.failFirst ?? 0));
  const definition = seamDefinition(nodeCount, Math.max(2, failFirst + 1), fault.fail !== false);
  const run: RunRecord = {
    runId: `run_${randomUUID()}`,
    tenantId,
    workflowId: definition.workflowId,
    status: 'pending',
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await insertRunWithStartContext(storage, run, { tenantId, definition });
  // Arm the fault BEFORE the executor runs, keyed on this run's id so two
  // concurrent seam calls cannot inject into each other.
  const ledger = ledgerFor(run.runId);
  ledger.failFirst = failFirst;
  ledger.hold = fault.hold === true;
  // The REAL executor. Its failed branch drives the real unwind.
  const { executeRun } = await import('../executor/executor.js');
  await executeRun(storage, run, definition, {});
  return { run, definition };
}

async function handleUnwind(req: Request, res: Response, deps: { storage: Storage }): Promise<void> {
  const body = (req.body ?? {}) as {
    nodes?: unknown;
    failFirstInverseAttempts?: unknown;
    hold?: unknown;
    fail?: unknown;
  };
  const requested = typeof body.nodes === 'number' ? Math.trunc(body.nodes) : 2;
  if (requested < 1 || requested > 8) {
    sendError(res, 400, 'validation_error', 'nodes must be an integer in 1..8');
    return;
  }
  // §21 recovery extension. Bounded at the seam per the contract (`0..3`) rather
  // than trusted: this is a fault injector, and an unbounded one is a way to
  // make the host spin.
  const failFirst =
    typeof body.failFirstInverseAttempts === 'number' ? Math.trunc(body.failFirstInverseAttempts) : 0;
  if (failFirst < 0 || failFirst > 3) {
    sendError(res, 400, 'validation_error', 'failFirstInverseAttempts must be an integer in 0..3');
    return;
  }
  // The CALLER's tenant, so the witness can read the run back through
  // `GET /v1/runs/{runId}` and assert the §D rollup. A seam-private tenant
  // would make that read a 404 and turn the rollup leg into a shape-only claim
  // — which is the exact failure §21 added `runId` to close.
  // §21 `fail?: boolean`, default `true`. Typed strictly rather than coerced:
  // a caller sending `"false"` is asking for the healthy run and would silently
  // get the failing one under a truthiness check, so the leg would assert
  // `unwind: none` against a run that unwound — passing for the wrong reason.
  if (body.fail !== undefined && typeof body.fail !== 'boolean') {
    sendError(res, 400, 'validation_error', 'fail must be a boolean');
    return;
  }
  const fail = body.fail !== false;
  const tenantId = req.tenantId ?? 'default';
  const { run } = await runSeamWorkflow(deps.storage, tenantId, requested, {
    failFirst,
    hold: body.hold === true,
    fail,
  });

  const events = (await deps.storage.listEvents(run.runId))
    .filter((e) => e.type.startsWith('compensation.'))
    .map((e) => ({ type: e.type, payload: e.payload }));

  res.status(200).json({
    runId: run.runId,
    events,
    compensatedOrder: ledgerFor(run.runId).inverses,
    inverseActions: await inverseActionReport(run),
  });
}

/**
 * §21's `inverseActions[]`, composed from TWO sources that must not be confused:
 *
 *   - the HOST's ledger projection (`ordinal`, `effectId`, `attempts`,
 *     `outcome`, `input`) — what the host recorded it did;
 *   - the SEAM's own recorder (`downstreamKeys`) — what the fake downstream
 *     actually received, one entry per attempt.
 *
 * Keeping them separate is the point. If the host also supplied the downstream
 * keys, the retry-stability leg would be checking the host's intent against
 * itself and would pass on a host that presented a different key every time.
 */
async function inverseActionReport(run: RunRecord): Promise<unknown[]> {
  const { compensationPlanReport } = await import('../host/compensationRuntime.js');
  const rows = await compensationPlanReport(run.tenantId, run.runId, ledgerFor(run.runId).inverses);
  const keys = ledgerFor(run.runId).downstreamKeys;
  return rows.map((r) => ({
    ...r,
    downstreamKeys: keys.get(r.ordinal) ?? [],
  }));
}

/**
 * §21 `replay`: run a workflow to a completed unwind, then REPLAY it, and
 * report how many inverse effects the replay fired.
 *
 * `refiredEffects` MUST be `0` (§F). The number is measured from the fake
 * inverse node's own recorder under the REPLAY's runId, not from an event
 * count — a replay that re-fires produces an event log byte-indistinguishable
 * from one that did not, which is exactly the failure the ADR 0533 counter
 * exists to catch and the same reasoning applies here.
 */
async function handleReplay(req: Request, res: Response, deps: { storage: Storage }): Promise<void> {
  const tenantId = req.tenantId ?? 'default';
  const { run: source, definition } = await runSeamWorkflow(deps.storage, tenantId, 2);

  const replay: RunRecord = {
    runId: `run_${randomUUID()}`,
    tenantId,
    workflowId: definition.workflowId,
    status: 'pending',
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    parentRunId: source.runId,
    forkMode: 'replay',
  };
  await insertRunWithStartContext(deps.storage, replay, { tenantId, definition });
  const { executeRun } = await import('../executor/executor.js');
  await executeRun(deps.storage, replay, definition, { replayInvocationsFromRunId: source.runId });

  const refiredEffects = ledgerFor(replay.runId).inverses.length;
  if (refiredEffects > 0) {
    log.error('compensation_replay_refired', { sourceRunId: source.runId, replayRunId: replay.runId, refiredEffects });
  }

  // §21 recovery extension / RFC 0151 §B+§F. `source` is the plan the source run
  // executed; `replayed` is the plan the REPLAY resolved and reported.
  //
  // They must deep-equal on `{ordinal, effectId, input}` — same identities, same
  // recorded inputs — while `refiredEffects` stays 0. That equality is not
  // arranged here: the replay reads the SOURCE run's recorded plan (§F, wired in
  // `compensationRuntime.unwindTerminatedRun`) precisely BECAUSE a replay mints
  // no obligations of its own, so if the host ever regressed to reading the
  // replay's own empty tree, `replayed` would come back empty and this leg would
  // fail rather than silently comparing nothing to nothing.
  const { compensationPlanReport, compensationPlanRunId } = await import('../host/compensationRuntime.js');
  const sourcePlan = await compensationPlanReport(tenantId, source.runId, ledgerFor(source.runId).inverses);
  const replayedPlan = await compensationPlanReport(tenantId, compensationPlanRunId(replay), ledgerFor(replay.runId).inverses);

  res.status(200).json({
    runId: replay.runId,
    refiredEffects,
    source: sourcePlan.map(planEntry),
    replayed: replayedPlan.map(planEntry),
  });
}

/** The §21 `{ordinal, effectId, input}` triple the replay legs compare. */
function planEntry(r: { ordinal: number; effectId: string; input?: Record<string, unknown> }) {
  return { ordinal: r.ordinal, effectId: r.effectId, input: r.input ?? {} };
}

// The seam does NOT own the "which plan does a replay read" rule — it imports
// `compensationPlanRunId` from the runtime. It briefly carried its own copy, and
// sabotaging the runtime's version left every test green: the seam kept
// reporting the source plan while the host had stopped resolving it. One owner
// is what makes the §F leg able to fail.

/**
 * §21 `operator` — drive the host's REAL §E operator path against a held plan.
 *
 * The seam supplies the presented `actor` and NOTHING else: the tenant/authority
 * decision, the `authorization.decided` records, and the resume are all
 * `host/compensationOperator.ts` + `host/compensationRuntime.ts`, which is what
 * makes this a witness rather than a mock. §21's non-vacuity rule is explicit
 * that "a seam that answers 200 to all three has demonstrated it consults
 * nothing".
 */
async function handleOperator(req: Request, res: Response, deps: { storage: Storage }): Promise<void> {
  const body = (req.body ?? {}) as {
    runId?: unknown; action?: unknown; justification?: unknown; nodeTypeId?: unknown;
    actor?: { tenantId?: unknown; principalId?: unknown; operator?: unknown };
  };
  const runId = typeof body.runId === 'string' ? body.runId : '';
  const action = body.action as CompensationOperatorAction;
  if (!runId || !COMPENSATION_OPERATOR_ACTIONS.includes(action)) {
    res.status(400).json({
      error: 'validation_error',
      message: `runId and action (${COMPENSATION_OPERATOR_ACTIONS.join(' | ')}) are required`,
      details: { retriable: false },
    });
    return;
  }
  const actor = {
    tenantId: typeof body.actor?.tenantId === 'string' ? body.actor.tenantId : '',
    principalId: typeof body.actor?.principalId === 'string' ? body.actor.principalId : '',
    operator: body.actor?.operator === true,
  };

  const run = await deps.storage.getRun(runId);
  // A run that does not exist and a run in ANOTHER TENANT answer identically —
  // RFC 0132 §A.2. Distinguishing them here would rebuild the existence oracle
  // the cross-tenant rule exists to close.
  if (!run) {
    res.status(404).json({ error: 'not_found', message: 'plan not found', details: { retriable: false } });
    return;
  }

  const decision = await decideCompensationOperatorAction({ run, actor, action });
  if (!decision.allowed) {
    // The canonical FLAT envelope (`rest-endpoints.md`): `error` + `message` at
    // the top, `retriable` under `details` — which is where `readRetriable`
    // looks, and where §21 says a refused override declares itself not
    // retriable. A top-level `retriable` reads as `undefined` to every peer
    // that follows the contract.
    res.status(decision.status).json({
      error: decision.code,
      message: decision.code === 'not_found' ? 'plan not found' : 'operator authority required',
      details: { retriable: false },
    });
    return;
  }

  if (action === 'skip' && typeof body.justification !== 'string') {
    res.status(409).json({
      error: 'compensation_action_invalid',
      message: '`skip` requires a non-empty justification',
      details: { retriable: false },
    });
    return;
  }
  const substituteNodeTypeId = typeof body.nodeTypeId === 'string' ? body.nodeTypeId : undefined;
  if (action === 'substitute' && (!substituteNodeTypeId || !getNodeRegistry().has(substituteNodeTypeId))) {
    res.status(409).json({
      error: 'compensation_action_invalid',
      message: '`substitute` requires a REGISTERED nodeTypeId',
      details: { retriable: false },
    });
    return;
  }

  let planVersion = 1;
  if (action === 'retry' || action === 'substitute') {
    // Clear the seam's injected hold so the retry can succeed — the fault was
    // the seam's, and leaving it armed would make the operator path look broken
    // when it is the fixture refusing.
    ledgerFor(run.runId).hold = false;
    ledgerFor(run.runId).faultOrdinal = null;
    const { resumeUnwindForOperator } = await import('../host/compensationRuntime.js');
    const nodeCount = ledgerFor(run.runId).forwards.length || 2;
    await resumeUnwindForOperator({
      storage: deps.storage,
      run,
      // Always the FAILING shape: this path resumes an unwind that a real
      // failure already started, so a healthy definition would describe a
      // different workflow than the one whose plan is being resumed.
      definition: seamDefinition(nodeCount, 2, true),
      ...(action === 'substitute' && substituteNodeTypeId ? { substituteNodeTypeId } : {}),
    });
    if (action === 'substitute') planVersion = 2;
  } else {
    await applyOperatorDisposition({
      run,
      action,
      ...(typeof body.justification === 'string' ? { justification: body.justification } : {}),
    });
  }

  const { compensationStatusForRuns } = await import('../host/compensationLedger.js');
  const status = (await compensationStatusForRuns(run.tenantId, [run.runId])).get(run.runId) ?? 'none';

  res.status(200).json({
    runId: run.runId,
    action,
    compensationStatus: status,
    planVersion,
    // `audited: true` is not decoration: `decideCompensationOperatorAction`
    // wrote the `authorization.decided` record before returning `allowed`, so
    // reaching this line means the record exists.
    audited: true,
  });
}

export function registerCompensationSeamRoutes(app: Express, deps: { storage: Storage }): void {
  if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
    log.info('compensation seam disabled (set OPENWOP_TEST_SEAM_ENABLED=true to enable)');
    return;
  }
  for (const base of SEAM_PATHS) {
    app.post(`${base}/unwind`, (req, res) => {
      void handleUnwind(req, res, deps).catch((err: unknown) => {
        log.error('compensation_seam_unwind_failed', { error: err instanceof Error ? err.message : String(err) });
        sendError(res, 500, 'internal_error', 'compensation seam failed');
      });
    });
    app.post(`${base}/replay`, (req, res) => {
      void handleReplay(req, res, deps).catch((err: unknown) => {
        log.error('compensation_seam_replay_failed', { error: err instanceof Error ? err.message : String(err) });
        sendError(res, 500, 'internal_error', 'compensation seam failed');
      });
    });
    // §21 recovery extension.
    app.post(`${base}/operator`, (req, res) => {
      void handleOperator(req, res, deps).catch((err: unknown) => {
        log.error('compensation_seam_operator_failed', { error: err instanceof Error ? err.message : String(err) });
        sendError(res, 500, 'internal_error', 'compensation seam failed');
      });
    });
  }
}

/** Test-only reset so suites do not inherit each other's fake-effect ledgers. */
export function __resetCompensationSeamForTest(): void {
  seamLedgers.clear();
}
