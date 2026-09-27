/**
 * ADR 0555 P1 — the isolation-adapter seam, and the fake adapter that proves
 * the contract without claiming to be a security boundary.
 *
 * An adapter's ONE job is to get a `DispatchEnvelope` to a worker, relay that
 * worker's host-calls to the broker, and bring back a `DispatchResult`. It
 * decides transport and containment; it decides nothing about capability,
 * authority, replay or trust — those live host-side, on the record the broker
 * reads. That split is what makes the interface version-neutral: P2's real
 * adapter implements the same two-method shape and inherits every guard.
 *
 * ── WHAT THE FAKE ADAPTER IS, AND IS NOT ──────────────────────────────────
 *
 * IT IS a real MESSAGE boundary. Every message crossing in either direction —
 * envelope, host-call request, host-call response, result — is `structuredClone`d,
 * which is precisely the predicate `postMessage` applies. A value that survives
 * here is one a `worker_threads` transport can carry; one that does not fails
 * here, typed, instead of surfacing in P2 as an opaque `DataCloneError`.
 *
 * IT IS NOT a process, filesystem, network or CPU boundary. The worker runs in
 * this process, on this event loop, with this heap. It cannot be killed, so its
 * wall-clock budget is enforced by ABANDONING the dispatch (the record is
 * cancelled, every later host-call is refused) rather than by stopping the code.
 * Saying otherwise would be exactly the dishonest advertisement ADR 0555 P4 is
 * gated on avoiding — and nothing here advertises `sandbox` anywhere.
 */

import { createLogger } from '../observability/logger.js';
import type { PackHostCallBroker } from './packHostCallBroker.js';
import { NO_GUARANTEES, type AdapterGuarantees } from './isolationGuarantees.js';
import { runIsolatedPackNode, type PackNodeFn, type PackNodeLoader } from './packWorkerRunner.js';
import {
  ISOLATION_TIMEOUT_CODE,
  NotSerializableError,
  assertStructuredCloneSafe,
  clampFailureMessage,
  type DispatchEnvelope,
  type DispatchResult,
  type HostCallRequest,
  type HostCallResponse,
} from './packWorkerContract.js';

const log = createLogger('host.isolationAdapter');

export interface IsolationAdapter {
  /** Stable id for logs + the operator surface. Never advertised on the wire. */
  readonly id: string;
  /**
   * ADR 0555 P2 — what this adapter actually ENFORCES, exhaustively.
   *
   * Compared against the pack's trust tier before dispatch; a tier requiring
   * more than the adapter enforces is REFUSED, never downgraded. The type is a
   * total `Record` so a new guarantee name is a compile error here and in every
   * adapter, rather than an absence that reads as "no" and means "unconsidered".
   */
  readonly guarantees: AdapterGuarantees;
  dispatch(envelope: DispatchEnvelope, broker: PackHostCallBroker): Promise<DispatchResult>;
}

/**
 * Load a pack node function the way a worker would: import the pack's entry and
 * pick the typeId out of its `nodes` map.
 *
 * A real isolate does this INSIDE the isolate, from bytes the host never
 * executed. The fake adapter does it in-process, where the module is already
 * imported and the import is cache-served — which is why the fake adapter is a
 * contract harness and not a containment claim.
 */
export const defaultPackNodeLoader: PackNodeLoader = async (envelope: DispatchEnvelope) => {
  const mod = (await import(envelope.entryUrl)) as { nodes?: Record<string, unknown> };
  const fn = mod.nodes?.[envelope.typeId];
  return typeof fn === 'function' ? (fn as PackNodeFn) : null;
};

export function createFakeIsolationAdapter(opts: { readonly loadNode?: PackNodeLoader } = {}): IsolationAdapter {
  const loadNode = opts.loadNode ?? defaultPackNodeLoader;
  return {
    id: 'fake-in-process',
    /**
     * NOTHING is enforced — stated in the type, not only in the prose above.
     *
     * This is what makes the P2 comparison bite rather than decorate: under the
     * untrusted tier's requirements this adapter is REFUSED, so the fake can
     * never become the thing quietly containing community code because someone
     * set one env var. It is a contract harness, and the record says so in the
     * one place the policy reads.
     */
    guarantees: NO_GUARANTEES,
    async dispatch(envelope: DispatchEnvelope, broker: PackHostCallBroker): Promise<DispatchResult> {
      // host → worker. A function or a live object in the envelope dies HERE.
      const sent = assertStructuredCloneSafe(envelope, 'dispatch envelope', 'pack_isolation_envelope_not_serializable');

      const hostCall = async (req: HostCallRequest): Promise<HostCallResponse> => {
        let wire: HostCallRequest;
        try {
          wire = assertStructuredCloneSafe(req, 'host call request', 'host_call_arguments_not_serializable');
        } catch (err) {
          return { ok: false, error: { code: err instanceof NotSerializableError ? err.code : 'internal_error', message: clampFailureMessage(err instanceof Error ? err.message : String(err)) } };
        }
        const res = await broker.hostCall(wire);
        try {
          return assertStructuredCloneSafe(res, 'host call response', 'host_result_not_serializable');
        } catch (err) {
          return { ok: false, error: { code: err instanceof NotSerializableError ? err.code : 'internal_error', message: clampFailureMessage(err instanceof Error ? err.message : String(err)) } };
        }
      };

      const run = runIsolatedPackNode({ envelope: sent, loadNode, hostCall });
      const result = await withWallClock(run, sent, broker.dispatchId);
      // worker → host.
      return assertStructuredCloneSafe(result, 'dispatch result', 'result_not_serializable');
    },
  };
}

/**
 * Enforce the wall-clock budget.
 *
 * The in-process worker cannot be terminated, so a timeout ABANDONS it: the
 * dispatcher cancels the record, so every host-call the abandoned execution
 * still attempts is refused `dispatch_cancelled` and its eventual result is
 * refused by the CAS. The node fails with a typed code and cannot leave a
 * privileged worker reusable — the strongest form available without a real
 * isolate, and stated as such rather than dressed up.
 */
async function withWallClock(
  run: Promise<DispatchResult>,
  envelope: DispatchEnvelope,
  dispatchId: string,
): Promise<DispatchResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DispatchResult>((resolve) => {
    timer = setTimeout(() => {
      log.warn('isolated pack dispatch exceeded its wall-clock budget; abandoning', {
        dispatchId, typeId: envelope.typeId, pack: envelope.packName, wallClockMs: envelope.budget.wallClockMs,
      });
      resolve({
        status: 'failure',
        error: {
          code: ISOLATION_TIMEOUT_CODE,
          message: `Isolated dispatch of '${envelope.typeId}' exceeded its ${envelope.budget.wallClockMs}ms wall-clock budget.`,
        },
        variablesWrites: [],
      });
    }, envelope.budget.wallClockMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
