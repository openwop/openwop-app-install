/**
 * `POST /v1/host/openwop-app/dispatch/fanout` — the RFC 0118 parallel-fan-out witness seam
 * (host-extension, non-normative path; the join semantics it exercises ARE normative).
 *
 * The conformance suite (`conformance/src/scenarios/dispatch-fanout-parallel.test.ts`, capability-
 * gated on `dispatch.fanOutSupported` + `"parallel"` in `fanOutPolicies`) drives this seam with
 * `{ nextWorkerIds, config }` and asserts a wait-all/collect fan-out joins on every child with
 * `joinOutcome: 'satisfied'`, a `children[]` of the right length, and a `mergeOrder` array.
 *
 * It runs the REAL `runParallelFanOut` coordinator + `foldJoin` (host/dispatchFanOut.ts) — the
 * normative core of RFC 0118. The seam supplies a deterministic child-dispatcher (each
 * `nextWorkerIds[i]` → a `completed` child terminal) so the witness exercises the genuine
 * bounded-concurrency coordination + join-fold without needing registered child workflows;
 * full executor-integrated parallel dispatch is the production consumer (ADR 0154 follow-on).
 *
 * Always mounted at the product path (the host honestly advertises dispatch.fanOutSupported);
 * the `/v1/host/sample/*` alias the vendored suite drives is env-gated to OPENWOP_TEST_SEAM_ENABLED.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import { OpenwopError } from '../types.js';
import {
  runParallelFanOut,
  HOST_MAX_FAN_OUT,
  type DispatchFanOutConfig,
  type ChildTerminal,
} from '../host/dispatchFanOut.js';

const RPC_PATH = '/v1/host/openwop-app/dispatch/fanout';

function tenantOf(req: Request): string {
  return (req as { tenantId?: string }).tenantId ?? 'default';
}

/** Parse the conformance `config` into a typed DispatchFanOutConfig (only the fan-out fields). */
function parseConfig(raw: unknown): DispatchFanOutConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const jp = (c.joinPolicy ?? undefined) as Record<string, unknown> | undefined;
  return {
    ...(typeof c.fanOutPolicy === 'string' ? { fanOutPolicy: c.fanOutPolicy as DispatchFanOutConfig['fanOutPolicy'] } : {}),
    ...(typeof c.maxConcurrency === 'number' ? { maxConcurrency: c.maxConcurrency } : {}),
    ...(jp
      ? {
          joinPolicy: {
            ...(typeof jp.mode === 'string' ? { mode: jp.mode as 'wait-all' | 'quorum' | 'first' | 'race' } : {}),
            ...(typeof jp.quorum === 'number' ? { quorum: jp.quorum } : {}),
            ...(typeof jp.onChildFailure === 'string' ? { onChildFailure: jp.onChildFailure as 'collect' | 'fail-fast' | 'absorb' } : {}),
          },
        }
      : {}),
  };
}

async function handleFanOut(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nextWorkerIds = body.nextWorkerIds;
    if (!Array.isArray(nextWorkerIds) || nextWorkerIds.length < 2 || !nextWorkerIds.every((w) => typeof w === 'string' && w)) {
      throw new OpenwopError('invalid_request', "'nextWorkerIds' must be an array of ≥2 worker id strings", 400);
    }
    const config = parseConfig(body.config);
    if (config.fanOutPolicy !== 'parallel') {
      throw new OpenwopError('invalid_request', "this seam exercises fanOutPolicy:'parallel'", 400);
    }
    const tenant = tenantOf(req);

    // Deterministic witness child-dispatcher: each worker → a `completed` child terminal with a
    // stable childRunId. The coordinator + fold are the REAL RFC 0118 logic.
    const dispatchChild = async (workerId: string, index: number): Promise<ChildTerminal> => ({
      childRunId: `fanout:${tenant}:${index}:${workerId}`,
      status: 'completed',
    });

    const out = await runParallelFanOut({ nextWorkerIds: nextWorkerIds as string[], config, dispatchChild, maxFanOut: HOST_MAX_FAN_OUT });
    res.json({
      joinOutcome: out.joinOutcome,
      children: out.children,
      mergeOrder: out.mergeOrder,
      completedCount: out.completedCount,
      failedCount: out.failedCount,
      cancelledCount: out.cancelledCount,
    });
  } catch (err) {
    next(err);
  }
}

export function registerDispatchFanOutRoutes(app: Express): void {
  // Product surface — always mounted (the host honestly advertises dispatch.fanOutSupported).
  app.post(RPC_PATH, handleFanOut);

  // Conformance alias — the pinned suite drives the fixed canonical /v1/host/sample/dispatch/fanout.
  // Env-gated (404s in prod); registered BEFORE testSeam.ts's catch-all sample→openwop-app rewrite.
  if (process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') {
    app.post('/v1/host/sample/dispatch/fanout', handleFanOut);
  }
}
