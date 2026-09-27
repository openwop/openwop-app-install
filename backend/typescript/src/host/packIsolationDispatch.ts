/**
 * ADR 0555 P1 — the executor-facing entry point for an isolated pack dispatch.
 *
 * One function, called from the ONE seam in `executor/executor.ts` where
 * `module.execute(ctx)` would otherwise run. It builds the envelope out of the
 * ctx the executor ALREADY built (never a second construction — a divergent
 * ctx would mean the isolated path runs a different node than the in-process
 * path), issues the dispatch record, hands the adapter a broker projected over
 * that same ctx, and folds the result back into a `NodeOutcome`.
 *
 * Read `packHostCallBroker.ts` for why this must NOT be nested inside the
 * executor's `runWithEffectContext`.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../observability/logger.js';
import {
  authorityFromWorkload,
  readRecordedAuthority,
  type AuthorityFacts,
} from './authorityContext.js';
import {
  HOST_WORKER_SCOPES,
  isWorkloadIdentityEnabled,
  mintWorkloadCredential,
  resolveWorkloadIdentity,
  verifyWorkloadCredential,
} from './workloadIdentity.js';
import { snapshotRunVariables } from './variablesRuntime.js';
import {
  cancelDispatch,
  issueDispatch,
  releaseDispatch,
} from './packDispatchRegistry.js';
import {
  createPackHostCallBroker,
  enumerateCtxGrant,
  narrowGrantByRequires,
} from './packHostCallBroker.js';
import {
  DISPATCH_PROTOCOL_VERSION,
  type DispatchBudget,
  type DispatchEnvelope,
  type DispatchResult,
  type PackNodeOrigin,
} from './packWorkerContract.js';
import type { IsolationAdapter } from './isolationAdapter.js';
import { createFakeIsolationAdapter } from './isolationAdapter.js';
import { createChildProcessIsolationAdapter } from './isolation/childProcessAdapter.js';
import { admitAdapterForTier } from './packIsolationPolicy.js';
import type { NodeContext, NodeModule, NodeOutcome } from '../executor/types.js';
import type { RunEffectContext } from './runEffectContext.js';

const log = createLogger('host.packIsolationDispatch');

/**
 * The opaque name an isolated pack worker presents. Never a hostname or an
 * instance id — the sweeper's rule, for the sweeper's reason: the subject is
 * hashed into an opaque principal precisely so the deployment is not published.
 */
export const PACK_ISOLATE_WORKLOAD_SUBJECT = 'worker/pack-isolate';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resource ceilings for one dispatch. Operator-tunable, never pack-tunable. */
export function isolationBudget(): DispatchBudget {
  return {
    wallClockMs: envInt('OPENWOP_PACK_ISOLATION_WALL_MS', 60_000),
    maxHostCalls: envInt('OPENWOP_PACK_ISOLATION_MAX_HOST_CALLS', 1000),
    maxResultBytes: envInt('OPENWOP_PACK_ISOLATION_MAX_RESULT_BYTES', 1_048_576),
  };
}

/**
 * Attribution for the dispatch record — the sweeper's two lanes, verbatim.
 *
 * Recorded first: an isolated execution is work the run was already authorized
 * to do, so it inherits that authorization rather than acquiring a new one.
 * Otherwise a credential this host mints for ITSELF and immediately verifies
 * back through the same path a peer's credential would take, so a bug in the
 * audience or trust-root logic fails the host's own workers first. `null` when
 * the profile is not configured — never widened to fill the gap.
 */
export async function packIsolateAuthority(
  runMetadata: Record<string, unknown> | undefined,
  tenantId: string,
): Promise<AuthorityFacts | null> {
  const recorded = readRecordedAuthority(runMetadata);
  if (recorded) return recorded;
  if (!isWorkloadIdentityEnabled()) return null;
  try {
    const token = await mintWorkloadCredential({
      subject: PACK_ISOLATE_WORKLOAD_SUBJECT,
      tenantId,
      scopes: HOST_WORKER_SCOPES,
    });
    const verified = await verifyWorkloadCredential(token);
    if (!verified.ok) {
      log.error('pack_isolate_workload_credential_unverifiable', { cause: verified.cause });
      return null;
    }
    const resolved = await resolveWorkloadIdentity(verified.identity, 'verified-credential', {
      verified: { tenantId: verified.tenantId, scopes: verified.scopes },
    });
    if (!resolved.ok) {
      log.error('pack_isolate_workload_identity_unresolved', { cause: resolved.cause });
      return null;
    }
    return authorityFromWorkload(resolved.principal, randomUUID());
  } catch (err) {
    // Fail closed on the IDENTITY, not on the dispatch: the node still runs, it
    // simply runs without a workload identity attached, which is the pre-P1
    // behaviour rather than a widened one.
    log.error('pack_isolate_workload_identity_error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** `NodeOutcome` suspend kinds (`executor/types.ts`), pinned by test. */
const SUSPEND_KINDS = new Set([
  'approval', 'clarification', 'refinement', 'cancellation', 'external-event',
  'conversation', 'timer', 'tour-step', 'walkthrough-step',
]);

/**
 * `OPENWOP_PACK_ISOLATION_ADAPTER` — WHAT does the isolating.
 * (`OPENWOP_PACK_ISOLATION` decides WHICH dispatches are isolated.)
 *
 *   `child` **(default, ADR 0555 P2)** one forked Node process per dispatch
 *           under the runtime permission model. Always available: it needs no
 *           infrastructure beyond the Node already running.
 *   `fake`  P1's in-process contract harness. Enforces nothing, so under the
 *           tier comparison it cannot run an untrusted pack — selecting it does
 *           not weaken containment, it makes untrusted dispatches REFUSE.
 *
 * An unrecognised value falls back to `child`, never to `fake`: a typo must not
 * be the thing that turns a real boundary into a harness.
 */
export type IsolationAdapterId = 'child' | 'fake';

export function isolationAdapterId(env: NodeJS.ProcessEnv = process.env): IsolationAdapterId {
  return env.OPENWOP_PACK_ISOLATION_ADAPTER === 'fake' ? 'fake' : 'child';
}

const adapters = new Map<IsolationAdapterId, IsolationAdapter>();

/** Memoized per id — an adapter holds a concurrency semaphore, so building a
 *  new one per dispatch would make the cap meaningless. */
export function adapterFor(explicit?: IsolationAdapter, env: NodeJS.ProcessEnv = process.env): IsolationAdapter {
  if (explicit) return explicit;
  const id = isolationAdapterId(env);
  let adapter = adapters.get(id);
  if (!adapter) {
    adapter = id === 'fake' ? createFakeIsolationAdapter() : createChildProcessIsolationAdapter();
    adapters.set(id, adapter);
  }
  return adapter;
}

/** Test seam — drop memoized adapters so a suite can change the env knob. */
export function __resetIsolationAdaptersForTests(): void {
  adapters.clear();
}

export interface IsolatedDispatchInput {
  readonly ctx: NodeContext;
  readonly module: NodeModule;
  readonly origin: PackNodeOrigin;
  readonly effectCtx: RunEffectContext;
  readonly runMetadata?: Record<string, unknown>;
  readonly suspendResolution?: { readonly resumeKey: string; readonly value: unknown };
  readonly adapter?: IsolationAdapter;
}

/**
 * Run one pack node through the isolated-worker contract and return the
 * `NodeOutcome` the executor would have produced in-process.
 *
 * Every failure arm below is a TYPED node failure. There is no path on which a
 * refused dispatch silently falls back to in-process execution: that fallback is
 * the thing the phase exists to make impossible.
 */
export async function dispatchPackNodeIsolated(input: IsolatedDispatchInput): Promise<NodeOutcome> {
  const { ctx, origin, effectCtx } = input;
  const adapter = adapterFor(input.adapter);

  // ADR 0555 P2 — BEFORE anything is issued or spawned: may this adapter run
  // this tier at all? Refused here rather than downgraded, and refused before a
  // dispatch record exists so a rejected pack leaves no half-built state.
  const admission = admitAdapterForTier(origin.tier, adapter);
  if (!admission.ok) {
    log.error('isolation adapter does not meet the trust tier requirements', {
      adapter: adapter.id, tier: origin.tier, typeId: origin.typeId, pack: origin.packName,
    });
    return { status: 'failure', error: { code: admission.code, message: admission.message } };
  }

  const budget = isolationBudget();
  const authority = await packIsolateAuthority(input.runMetadata, ctx.tenantId);
  const grant = narrowGrantByRequires(enumerateCtxGrant(ctx), input.module.requires);

  const issued = issueDispatch({
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    tenantId: ctx.tenantId,
    typeId: origin.typeId,
    packName: origin.packName,
    packVersion: origin.packVersion,
    effectCtx,
    authority,
    grant,
    budget,
  });

  const envelope: DispatchEnvelope = {
    protocol: DISPATCH_PROTOCOL_VERSION,
    dispatchId: issued.dispatchId,
    token: issued.token,
    typeId: origin.typeId,
    packName: origin.packName,
    packVersion: origin.packVersion,
    entryUrl: origin.entryUrl,
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    tenantId: ctx.tenantId,
    ...(ctx.scopeId !== undefined ? { scopeId: ctx.scopeId } : {}),
    inputs: ctx.inputs,
    ...(ctx.config !== undefined ? { config: ctx.config } : {}),
    ...(ctx.nodeAgent !== undefined ? { nodeAgent: ctx.nodeAgent as unknown as Record<string, unknown> } : {}),
    configurable: ctx.configurable,
    ...(ctx.triggerData !== undefined ? { triggerData: ctx.triggerData } : {}),
    attempt: ctx.attempt,
    // Always untrusted under isolation — a widening, never a copy. See
    // `packWorkerContract.ts` for why the run's own value is not inherited.
    trustBoundary: 'untrusted',
    ...(ctx.interactiveSession !== undefined ? { interactiveSession: ctx.interactiveSession } : {}),
    ...(ctx.compaction !== undefined ? { compaction: ctx.compaction as unknown as Record<string, unknown> } : {}),
    ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
    ...(ctx.actingUserId !== undefined ? { actingUserId: ctx.actingUserId } : {}),
    budget,
    capabilityGrant: [...grant].sort(),
    variablesSnapshot: snapshotRunVariables(ctx.runId) ?? {},
    ...(input.suspendResolution ? { suspendResolution: input.suspendResolution } : {}),
  };
  // `secrets` is absent by CONSTRUCTION above — there is no branch that could
  // add it. `pack-worker-runner.test.ts` asserts the key is missing anyway,
  // because "absent by construction" is a claim a future edit can falsify.

  const broker = createPackHostCallBroker({ dispatchId: issued.dispatchId, ctx, grant });

  try {
    let result: DispatchResult;
    try {
      result = await adapter.dispatch(envelope, broker);
    } catch (err) {
      cancelDispatch(issued.dispatchId);
      return {
        status: 'failure',
        error: {
          code: 'pack_isolation_adapter_failed',
          message: `Isolated dispatch of '${origin.typeId}' failed in the adapter: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    const submitted = broker.submitResult({
      dispatchId: envelope.dispatchId,
      token: envelope.token,
      result,
    });
    if (!submitted.accepted) {
      cancelDispatch(issued.dispatchId);
      log.error('isolated pack result refused', {
        dispatchId: issued.dispatchId, runId: ctx.runId, nodeId: ctx.nodeId,
        pack: origin.packName, typeId: origin.typeId, refusal: submitted.refusal,
      });
      return {
        status: 'failure',
        error: {
          code: submitted.refusal,
          message: `The isolated worker's result for '${origin.typeId}' was refused by the host (${submitted.refusal}).`,
        },
      };
    }
    return toNodeOutcome(submitted.result);
  } finally {
    cancelDispatch(issued.dispatchId);
    releaseDispatch(issued.dispatchId);
  }
}

/** Fold an accepted `DispatchResult` into the executor's `NodeOutcome`. */
export function toNodeOutcome(result: DispatchResult): NodeOutcome {
  if (result.status === 'success') return { status: 'success', outputs: result.outputs };
  if (result.status === 'failure') return { status: 'failure', error: result.error };
  const kind = SUSPEND_KINDS.has(result.interrupt.kind) ? result.interrupt.kind : 'external-event';
  return {
    status: 'suspended',
    interrupt: {
      // The exact shape the executor's own `SuspendSignal` branch builds — the
      // resume path keys on `__resumeKey` + `__resumeStyle` to decide whether to
      // re-invoke the node, so an isolated suspend that omitted them would
      // resume down the WRONG lane.
      kind: kind as NonNullable<Extract<NodeOutcome, { status: 'suspended' }>['interrupt']>['kind'],
      data: { ...result.interrupt.data, __resumeKey: result.interrupt.resumeKey, __resumeStyle: 'reinvoke' },
      ...(result.interrupt.resumeSchema !== undefined ? { resumeSchema: result.interrupt.resumeSchema } : {}),
    },
  };
}
