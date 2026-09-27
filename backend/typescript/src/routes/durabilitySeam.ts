/**
 * RFC 0158 §"Witnessing the recovery rows" — the durability conformance seam
 * (ADR 0739, `WHD-5`).
 *
 *   GET  /host/durability/kill    the suite's PROBE — answers without firing
 *   POST /host/durability/kill    { mode, workflowId? } → { runId, … }
 *   GET  /host/durability/bound   { class, bound, terms[], classes }
 *
 * Registered at the `/v1/…` literal; the protocol negotiator's unversioned
 * major-2 rewrite is what makes `/host/durability/*` reach it (`/host` is
 * already a mounted v2 prefix via `schemas/v2/path-manifest.json`). A route
 * registered at `/host/…` alone 404s the probe and the whole scenario file
 * silently records `inapplicable`.
 *
 * THE ONLY DRIVER is `v2-durability-recovery.test.ts` in the conformance
 * package. Non-normative host-extension route: it advertises nothing and mints
 * no capability field (RFC 0158 §E.10).
 *
 * ── THE GATE (ADR 0739 D1) ──────────────────────────────────────────────────
 * Two conditions, and every handler here — including the probe — checks both:
 *
 *   1. `OPENWOP_TEST_SEAM_ENABLED === 'true'` — the gate every seam on this
 *      host rides. RFC 0158 item 12 forbids minting a second flag for this.
 *   2. `isOwnProcess()` — `main()` was the entry point. This route sends
 *      SIGKILL to the CURRENT process. Under `createApp` (the in-process
 *      conformance lane, every vitest) the current process is the harness.
 *
 * Off ⇒ 404, which the suite reads as "this host claims no durable-execution
 * rung" → `inapplicable`. That is the TRUE answer for a lane that cannot
 * witness a process death, and it is why production — seams off by deliberate
 * choice — exposes no self-terminating endpoint.
 *
 * ── THE KILL IS REAL (D2) ───────────────────────────────────────────────────
 * SIGKILL, not `process.exit()`: exit hooks and graceful shutdown are exactly
 * the code a crash does not run. It is armed on the response's `finish` so the
 * suite always learns the `runId` it must follow across the death.
 */
import type { Express, Request, Response, NextFunction } from 'express';

import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from '../host/index.js';
import { buildRunRecord, dispatchRunInBackground } from '../host/runDispatch.js';
import { executeRun } from '../executor/executor.js';
import { seedRunVariables } from '../host/variablesRuntime.js';
import { insertRunWithStartContext } from '../host/runInsert.js';
import { resolveLaunchWorkflow } from '../host/resolveLaunchDefinition.js';
import { ownerStampFromRequest } from '../host/runOwner.js';
import { personalTenantOf } from '../host/requestSubject.js';
import { isOwnProcess } from '../host/processIdentity.js';
import {
  declaredRecoveryBoundMs,
  recoveryBoundTermList,
  type RecoveryClass,
} from '../host/recoveryBound.js';
import { getEventLog } from '../executor/eventLog.js';
import { toWireRunId } from '../host/v2Ids.js';
import { sendError } from '../middleware/errorEnvelope.js';
import { createLogger } from '../observability/logger.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { CONFORMANCE_HTTP_EFFECT_TYPE_ID } from '../bootstrap/conformanceHttpEffectNode.js';

const log = createLogger('durability-seam');

export const DURABILITY_KILL_PATH = '/v1/host/durability/kill';
export const DURABILITY_BOUND_PATH = '/v1/host/durability/bound';

/** The modes that end in a process death. */
export const KILL_MODES = ['after-accept', 'during-execution'] as const;
export type KillMode = (typeof KILL_MODES)[number];

/**
 * `duplicate-delivery` rides the same route (the suite drives it there) but
 * KILLS NOTHING: RFC 0158 §C asks what happens when the same accepted work is
 * delivered twice, which needs two deliveries, not a death.
 */
export const DUPLICATE_DELIVERY_MODE = 'duplicate-delivery';
export const SEAM_MODES = [...KILL_MODES, DUPLICATE_DELIVERY_MODE] as const;
export type SeamMode = (typeof SEAM_MODES)[number];

/**
 * The work `duplicate-delivery` delivers twice (ADR 0739 D4). From suite 2.32.0
 * the scenario names NO workflow — "the seam chooses the work and MUST choose
 * work that records >= 1 effect" — because no canonical fixture is guaranteed
 * effectful (`conformance-noop` records none here, and an empty projection is
 * `blocked`). This fixture's second node emits a REAL notification through the
 * ADR 0618 invocation-log claim, which is the dedup this row exists to test.
 */
export const DUPLICATE_DELIVERY_WORKFLOW_ID = 'conformance-replay-side-effect';

/**
 * The `effectUrl` contract's work: ONE node, ONE outbound request, nothing in
 * front of it. Deliberately no `core.delay` ahead of the effect — on the
 * notification fixture above, delivery 2 is aborted inside the delay by the
 * executor's terminal check and never reaches the effect, which protects the
 * host by accident. This definition removes the accident so the row measures
 * the effect path itself (ADR 0739 D4). It is built in code, not resolved from
 * the catalog, so its run is inserted WITHOUT an outbox row: a re-dispatch could
 * not re-resolve it (`insertRunWithStartContext` § `enqueueDispatch`).
 */
export const HTTP_EFFECT_WORKFLOW_ID = 'conformance.durability.http-effect';
export function httpEffectDefinition(effectUrl: string): WorkflowDefinition {
  return {
    workflowId: HTTP_EFFECT_WORKFLOW_ID,
    nodes: [{ nodeId: 'effect', typeId: CONFORMANCE_HTTP_EFFECT_TYPE_ID, config: { url: effectUrl }, inputs: {} }],
    edges: [],
  };
}

/** Which mechanism owns the work at the moment of death — and so which bound applies. */
export const RECOVERY_CLASS_BY_MODE: Record<KillMode, RecoveryClass> = {
  // Held before dispatch: no dispatch lease exists; the outbox lane recovers it.
  'after-accept': 'unleased',
  // Killed at the first `node.started`: the run holds a dispatch lease that must lapse.
  'during-execution': 'leased',
};

export interface DurabilitySeamDeps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

/** A genuine, uncatchable death of THIS process (ADR 0739 D2). */
const sigkillSelf = (): void => { process.kill(process.pid, 'SIGKILL'); };
/** What is dying, for the log line and for a test's recorder. The real kill ignores it. */
export interface DeathContext { mode: KillMode; runId: string }
let terminator: (ctx: DeathContext) => void = sigkillSelf;

/**
 * Test-only. The route is registered through `createApp`, so a test cannot
 * pass a terminator as a dependency — and the default would SIGKILL the vitest
 * worker. `null` restores the real kill. Set this BEFORE `markOwnProcess()`.
 */
export function setDurabilityTerminatorForTests(fn: ((ctx: DeathContext) => void) | null): void {
  terminator = fn ?? sigkillSelf;
}

export function durabilitySeamEnabled(): boolean {
  return process.env.OPENWOP_TEST_SEAM_ENABLED === 'true' && isOwnProcess();
}

export function validateKillBody(body: unknown): { error: string } | { mode: SeamMode; workflowId: string; effectUrl?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const mode = b['mode'];
  if (typeof mode !== 'string' || !(SEAM_MODES as readonly string[]).includes(mode)) {
    return { error: `mode must be one of ${SEAM_MODES.join(', ')}` };
  }
  // The seam CHOOSES the duplicate-delivery work; a requested workflowId is
  // ignored there (2.31.1 sent `conformance-noop`, which records no effects)
  // and the response echoes the one actually used.
  if (mode === DUPLICATE_DELIVERY_MODE) {
    const effectUrl = b['effectUrl'];
    if (effectUrl === undefined) return { mode, workflowId: DUPLICATE_DELIVERY_WORKFLOW_ID };
    // Suite >= 2.32.0: the effect is counted WHERE IT LANDS, so it must be an
    // outbound request to a receiver the suite owns.
    let parsedUrl: URL | null = null;
    try { parsedUrl = typeof effectUrl === 'string' ? new URL(effectUrl) : null; } catch { parsedUrl = null; }
    if (!parsedUrl || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')) {
      return { error: 'effectUrl must be an absolute http(s) URL when present' };
    }
    return { mode, workflowId: HTTP_EFFECT_WORKFLOW_ID, effectUrl: parsedUrl.toString() };
  }
  if (typeof b['workflowId'] !== 'string' || b['workflowId'].length === 0) {
    return { error: 'workflowId must be a non-empty string' };
  }
  return { mode: mode as SeamMode, workflowId: b['workflowId'] };
}

function classBound(cls: RecoveryClass): { bound: number; terms: ReadonlyArray<{ name: string; ms: number }> } {
  return { bound: declaredRecoveryBoundMs(cls), terms: recoveryBoundTermList(cls) };
}

function refuseWhenOff(res: Response): boolean {
  if (durabilitySeamEnabled()) return false;
  sendError(res, 404, 'not_found', 'The durability conformance seam is not enabled on this host.');
  return true;
}

export function registerDurabilitySeam(app: Express, deps: DurabilitySeamDeps): void {
  const { storage, hostSuite } = deps;
  const terminate = (ctx: DeathContext): void => {
    log.warn('durability_seam_kill', { mode: ctx.mode, runId: ctx.runId });
    terminator(ctx);
  };

  // The PROBE. The suite GETs this before firing anything: 404/405 = no seam.
  // It must answer WITHOUT killing — "firing the kill to discover whether it
  // exists would terminate a host that never claimed the rung".
  app.get(DURABILITY_KILL_PATH, (_req: Request, res: Response) => {
    if (refuseWhenOff(res)) return;
    res.status(200).json({ modes: SEAM_MODES, recoveryClassByMode: RECOVERY_CLASS_BY_MODE });
  });

  app.get(DURABILITY_BOUND_PATH, (req: Request, res: Response) => {
    if (refuseWhenOff(res)) return;
    const asked = req.query['class'];
    if (asked !== undefined && asked !== 'leased' && asked !== 'unleased') {
      sendError(res, 400, 'validation_error', 'class must be "leased" or "unleased"');
      return;
    }
    // RFC 0158 UQ1: the bound is PER CLASS and a bare max is "a lie by
    // aggregation". The top level therefore always NAMES its class, and the
    // other class is beside it rather than folded into it.
    const cls: RecoveryClass = asked ?? 'leased';
    res.status(200).json({
      class: cls,
      ...classBound(cls),
      classes: { unleased: classBound('unleased'), leased: classBound('leased') },
    });
  });

  app.post(DURABILITY_KILL_PATH, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (refuseWhenOff(res)) return;
      const parsed = validateKillBody(req.body);
      if ('error' in parsed) {
        sendError(res, 400, 'validation_error', parsed.error);
        return;
      }
      const tenantId = req.tenantId ?? 'default';
      const wf = parsed.effectUrl !== undefined
        ? { definition: httpEffectDefinition(parsed.effectUrl) }
        : await resolveLaunchWorkflow(hostSuite.workflowCatalog, tenantId, parsed.workflowId, { launch: 'published' });
      if (!wf) {
        sendError(res, 404, 'not_found', `workflow "${parsed.workflowId}" is not resolvable for this caller — the exercise has no work to accept`);
        return;
      }

      // THE REAL ACCEPTANCE — the same two calls `POST /runs` makes. The run row
      // and its `dispatch_outbox` row commit together; that outbox row is the
      // whole of the durable intent the recovery must act on. The run is owned
      // by the CALLER so the suite can read it back across the death.
      const personalTenant = personalTenantOf(req);
      const run = buildRunRecord({
        workflowId: parsed.workflowId,
        tenantId,
        inputs: null,
        metadata: { seededBy: 'conformance-seam', durabilityExercise: parsed.mode },
        actingUserId: req.userId ?? req.principal?.principalId,
        ...(personalTenant ? { personalTenant } : {}),
        owner: ownerStampFromRequest(req),
      });
      await insertRunWithStartContext(storage, run, { enqueueDispatch: parsed.effectUrl === undefined, definition: wf.definition });

      if (parsed.mode === DUPLICATE_DELIVERY_MODE) {
        // TWO REAL DELIVERIES of the one accepted run, CONCURRENTLY — the
        // setImmediate hint racing an outbox redelivery is how this happens in
        // production. Nothing here serialises them or puts a delay in front of
        // the effect: what stops the second delivery must be the HOST's fence
        // (ADR 0740's execution claim), or this exercise witnesses the seam.
        // No ledger row is planted: that would witness the projection.
        seedRunVariables(run.runId, wf.definition.variables, { delayMs: 0 });
        const deliver = () =>
          executeRun(storage, run, wf.definition, { policyResolver: hostSuite.providerPolicyResolver });
        const outcomes = await Promise.allSettled([deliver(), deliver()]);
        // What each delivery actually DID, from `executeRun`'s own return — so a
        // reader can tell "the fence refused the second" (ADR 0740) from "only
        // one was ever attempted", which look identical at the receiver.
        const deliveries = outcomes.map((o) =>
          o.status === 'rejected' ? 'threw' : o.value.duplicateDelivery ? 'duplicate-refused' : 'executed');
        res.status(201).json({
          runId: toWireRunId(run.runId, tenantId),
          mode: parsed.mode,
          workflowId: parsed.workflowId,
          deliveries,
        });
        return;
      }

      // Arm the death BEFORE responding, fire it only AFTER the response is out.
      const killMode: KillMode = parsed.mode;
      if (killMode === 'after-accept') {
        // HOLD-DISPATCH (RFC 0158 item 11): `dispatchRunInBackground` is
        // deliberately never called. Accepted, durable, undispatched — then dead.
        res.once('finish', () => setImmediate(() => terminate({ mode: killMode, runId: run.runId })));
      } else {
        // Die at the run's first `node.started` — NOT at `run.started`.
        //
        // MEASURED, and the first draft got this wrong: `executeRun` appends
        // `run.started` BEFORE it writes `status: 'running'` and BEFORE it takes
        // the dispatch lease. A kill in the `run.started` fanout therefore
        // leaves a `pending`, UNLEASED run — which the outbox lane recovers in
        // ~10 s. The supervised lane showed exactly that (resumed in 11.6 s)
        // while this seam labelled the exercise `leased` / 750 s: a green row
        // whose label named a mechanism it never touched. By the first
        // `node.started` the run is `running` and holds its lease, so recovery
        // must come from LEASE EXPIRY + the orphan lane — the mechanism RFC
        // 0158's measured 16-minute wedge was in, and the one worth witnessing.
        // `test/rfc0158-durability-seam.test.ts` pins that state at death.
        const unsubscribe = getEventLog().subscribe((event) => {
          if (event.runId !== run.runId || event.type !== 'node.started') return;
          unsubscribe();
          terminate({ mode: killMode, runId: run.runId });
        });
        res.once('finish', () => dispatchRunInBackground({ storage, run, definition: wf.definition, hostSuite }));
      }

      res.status(202).json({
        runId: toWireRunId(run.runId, tenantId),
        mode: killMode,
        recoveryClass: RECOVERY_CLASS_BY_MODE[killMode],
        // The bound that applies to THIS exercise — so a driver waiting out the
        // recovery never has to guess a class or fall back on the slower one.
        recoveryBoundMs: declaredRecoveryBoundMs(RECOVERY_CLASS_BY_MODE[killMode]),
      });
    } catch (err) {
      next(err);
    }
  });
}
