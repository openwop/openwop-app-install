/**
 * ADR 0555 P1 — the WORKER side of the contract, transport-agnostic.
 *
 * This module is what a worker runs. It holds no host state, imports nothing
 * from the executor, and reaches the host only through the `hostCall` function
 * it is handed — so the same code runs inside the fake in-process adapter today
 * and inside P2's real isolate with a `MessagePort` transport, unchanged. If it
 * ever needs a host import to work, the boundary has been broken.
 *
 * Its whole job is to rebuild something shaped like `NodeContext` out of a
 * DATA envelope plus one RPC function, invoke `fn(ctx)`, and reduce whatever
 * happens into the closed three-arm `DispatchResult`.
 *
 * ── THE THREE MEMBERS THAT ARE NOT RPC ────────────────────────────────────
 *
 *   `secrets`    ABSENT — not empty, not a stub. `'secrets' in ctx` is false, so
 *                a pack that reads it gets `undefined` and fails on its own
 *                honest check (`vendor.myndhyve.ads-publish-*` already do
 *                exactly that: "host does not expose ctx.secrets.resolve").
 *                Such packs are refused at dispatch anyway; this is the second
 *                line, not the first.
 *   `variables`  SYNChronous by contract (`get(name): unknown`, not a Promise),
 *                which RPC cannot preserve. Reads come from the snapshot in the
 *                envelope, writes accumulate locally AND are visible to a
 *                later `get` in the same execution, and the whole write set
 *                rides back on the result for the host to apply.
 *   `suspend` /  Control flow. On a resume re-invoke with a matching
 *   `interrupt`  `resumeKey` it returns the seeded value inline — byte-for-byte
 *                the `makeSuspendFn` short-circuit the spec requires. Otherwise
 *                it throws a worker-local signal that becomes the `suspended`
 *                result arm.
 *
 * ── WHY THE SUSPEND SIGNAL IS CLASSIFIED BY `.name` ───────────────────────
 *
 * `instanceof` is meaningless across a realm: a worker cannot import the host's
 * `SuspendSignal` class and be the same class. `aiProvidersHost.ts` already
 * classifies this exact signal by `.name` for the same reason, so the worker
 * follows the established, serialization-safe precedent rather than inventing a
 * marker field.
 */

import {
  DISPATCH_PROTOCOL_VERSION,
  type DispatchEnvelope,
  type DispatchResult,
  type HostCallRequest,
  type HostCallResponse,
  type VariableWrite,
} from './packWorkerContract.js';

/** A pack node's exported function, as `packs/tarballLoader.ts` invokes it. */
export type PackNodeFn = (ctx: unknown) => Promise<unknown> | unknown;

/** How the worker reaches the host. The ONLY host dependency in this file. */
export type HostCallTransport = (req: HostCallRequest) => Promise<HostCallResponse>;

/** How the worker obtains the node function for an envelope. The fake adapter
 *  imports the pack's entry URL; P2's isolate does the same inside the isolate. */
export type PackNodeLoader = (envelope: DispatchEnvelope) => Promise<PackNodeFn | null>;

/** Thrown by the worker's `ctx.suspend`. Named — never `instanceof`-matched. */
class WorkerSuspendSignal extends Error {
  constructor(
    readonly kind: string,
    readonly resumeKey: string,
    readonly data: Record<string, unknown>,
    readonly resumeSchema?: Record<string, unknown>,
    readonly timeoutMs?: number,
  ) {
    super(`suspend:${kind}:${resumeKey}`);
    this.name = 'SuspendSignal';
  }
}

/**
 * `spec/v1/interrupt.md` kind mapping, duplicated here ON PURPOSE.
 *
 * The worker cannot import `executor/suspendSignal.ts` — that module is host
 * code and importing it would give the worker a host dependency the transport
 * cannot carry. The values are pinned against the host's `mapSuspendKind` by
 * `pack-worker-runner.test.ts`, so the duplication is a test-enforced mirror
 * rather than a copy that can drift.
 */
function mapKind(reason: unknown): string {
  switch (reason) {
    case 'approval':
    case 'low-confidence':
      return 'approval';
    case 'duration':
    case 'until':
    case 'timer':
      return 'timer';
    case 'clarification':
    case 'conversation-input':
      return 'clarification';
    case 'refinement':
      return 'refinement';
    case 'cancellation':
      return 'cancellation';
    case 'external-event':
      return 'external-event';
    case 'conversation':
    case 'conversation.start':
      return 'conversation';
    default:
      return 'external-event';
  }
}

export async function runIsolatedPackNode(input: {
  readonly envelope: DispatchEnvelope;
  readonly loadNode: PackNodeLoader;
  readonly hostCall: HostCallTransport;
}): Promise<DispatchResult> {
  const { envelope, hostCall } = input;
  const variablesWrites: VariableWrite[] = [];

  if (envelope.protocol !== DISPATCH_PROTOCOL_VERSION) {
    return failure('pack_isolation_protocol_unsupported', `worker speaks protocol ${DISPATCH_PROTOCOL_VERSION}, envelope declares ${String(envelope.protocol)}`, variablesWrites);
  }

  let fn: PackNodeFn | null;
  try {
    fn = await input.loadNode(envelope);
  } catch (err) {
    return failure('pack_node_load_failed', err instanceof Error ? err.message : String(err), variablesWrites);
  }
  if (typeof fn !== 'function') {
    return failure('pack_node_load_failed', `pack '${envelope.packName}' exports no node function for '${envelope.typeId}'`, variablesWrites);
  }

  const ctx = buildWorkerContext(envelope, hostCall, variablesWrites);

  let result: unknown;
  try {
    result = await fn(ctx);
  } catch (err) {
    // Control flow first — a suspend is not an error (`tarballLoader.ts` rethrows
    // it for exactly this reason). Matched by `.name`, never `instanceof`.
    if (err && typeof err === 'object' && (err as { name?: unknown }).name === 'SuspendSignal') {
      const s = err as WorkerSuspendSignal;
      return {
        status: 'suspended',
        interrupt: {
          kind: typeof s.kind === 'string' ? s.kind : 'external-event',
          resumeKey: String(s.resumeKey ?? envelope.nodeId),
          data: s.data && typeof s.data === 'object' ? s.data : {},
          ...(s.resumeSchema !== undefined ? { resumeSchema: s.resumeSchema } : {}),
          ...(typeof s.timeoutMs === 'number' ? { timeoutMs: s.timeoutMs } : {}),
        },
        variablesWrites,
      };
    }
    // Loader rule, verbatim: a thrown error's own `.code` survives (policy_denied
    // / model_not_allowed carry policy meaning), else `pack_node_error`.
    const rawCode = err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : 'pack_node_error';
    const rawMessage = err instanceof Error ? err.message : String(err);
    return failure(rawCode, augmentCapabilityMessage(rawCode, rawMessage), variablesWrites);
  }

  // A RETURNED outcome can only be success or failure — suspension is only ever
  // reachable by throw, in-process and here alike.
  const r = result as { status?: unknown; outputs?: unknown; error?: { code?: unknown; message?: unknown } };
  if (r && r.status === 'success') {
    return {
      status: 'success',
      outputs: (r.outputs && typeof r.outputs === 'object' ? r.outputs : {}) as Record<string, unknown>,
      variablesWrites,
    };
  }
  const returnedCode = typeof r?.error?.code === 'string' ? r.error.code : 'pack_node_error';
  const returnedMessage = typeof r?.error?.message === 'string' ? r.error.message : 'Pack node returned non-success outcome';
  return failure(returnedCode, returnedMessage, variablesWrites);
}

/** The loader's `host_capability_missing` guide pointer, preserved verbatim. */
function augmentCapabilityMessage(code: string, message: string): string {
  return code.toLowerCase() === 'host_capability_missing'
    ? `${message}. This host does not advertise the required surface — see GET /.well-known/openwop capabilities.hostSurfaces, or run examples/hosts/postgres for a host that wires every surface.`
    : message;
}

function failure(code: string, message: string, variablesWrites: VariableWrite[]): DispatchResult {
  return { status: 'failure', error: { code, message }, variablesWrites };
}

/**
 * Build the proxy `ctx`.
 *
 * Data members are copied verbatim from the envelope. Every granted capability
 * becomes a function that RPCs. Nothing else exists — a member the grant does
 * not name is simply absent, which is the same shape a pack already handles
 * today for an unwired host surface (`typeof ctx.x?.y !== 'function'`).
 */
function buildWorkerContext(
  envelope: DispatchEnvelope,
  hostCall: HostCallTransport,
  variablesWrites: VariableWrite[],
): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    runId: envelope.runId,
    nodeId: envelope.nodeId,
    tenantId: envelope.tenantId,
    inputs: envelope.inputs,
    configurable: envelope.configurable,
    attempt: envelope.attempt,
    trustBoundary: envelope.trustBoundary,
  };
  if (envelope.scopeId !== undefined) ctx.scopeId = envelope.scopeId;
  if (envelope.config !== undefined) ctx.config = envelope.config;
  if (envelope.nodeAgent !== undefined) ctx.nodeAgent = envelope.nodeAgent;
  if (envelope.triggerData !== undefined) ctx.triggerData = envelope.triggerData;
  if (envelope.interactiveSession !== undefined) ctx.interactiveSession = envelope.interactiveSession;
  if (envelope.compaction !== undefined) ctx.compaction = envelope.compaction;
  if (envelope.userId !== undefined) ctx.userId = envelope.userId;
  if (envelope.actingUserId !== undefined) ctx.actingUserId = envelope.actingUserId;
  // `secrets` is deliberately never assigned. Do not "helpfully" add `{}` here:
  // an empty bag reads to a pack as "the host has no secrets for me" rather than
  // "this capability does not exist in isolation", and the two must not be
  // confused. `pack-worker-runner.test.ts` asserts the key is absent.

  let seq = 0;
  const call = async (surface: string, method: string, args: unknown[]): Promise<unknown> => {
    seq += 1;
    const res = await hostCall({
      dispatchId: envelope.dispatchId,
      token: envelope.token,
      seq,
      surface,
      method,
      args,
    });
    if (res.ok) return res.value;
    // Reconstruct a WORKER-LOCAL Error carrying the host's code, so pack code
    // sees the same `{message, code}` shape it sees in-process. Same discipline
    // as `host/sandbox.ts`'s bridge: never hand back a live host object.
    throw Object.assign(new Error(res.error.message), { code: res.error.code });
  };

  for (const key of envelope.capabilityGrant) {
    const parts = key.split('.');
    const method = parts.pop();
    if (!method) continue;
    const surface = parts.join('.');
    let target = ctx;
    for (const part of parts) {
      const existing = target[part];
      if (!existing || typeof existing !== 'object') target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    target[method] = (...args: unknown[]): Promise<unknown> => call(surface, method, args);
  }

  // ── variables: snapshot in, write-behind out, SYNCHRONOUS both ways ──────
  const local: Record<string, unknown> = { ...envelope.variablesSnapshot };
  ctx.variables = {
    get: (name: string): unknown => local[name],
    set: (name: string, value: unknown): void => {
      local[name] = value; // a later get() in this execution sees the write
      variablesWrites.push({ name, value });
    },
  };

  // ── suspend / interrupt: short-circuit or throw ──────────────────────────
  const suspend = (payload: Record<string, unknown>): Promise<unknown> => {
    const resumeKey = String(payload?.resumeKey ?? payload?.key ?? envelope.nodeId);
    const resolution = envelope.suspendResolution;
    if (resolution && resolution.resumeKey === resumeKey) return Promise.resolve(resolution.value);
    const schema = (payload?.answerSchema ?? payload?.resumeSchema) as Record<string, unknown> | undefined;
    throw new WorkerSuspendSignal(
      mapKind(payload?.reason ?? payload?.kind),
      resumeKey,
      { ...payload },
      schema,
      typeof payload?.timeoutMs === 'number' ? payload.timeoutMs : undefined,
    );
  };
  ctx.suspend = suspend;
  ctx.interrupt = suspend;

  return ctx;
}
