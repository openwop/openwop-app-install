/**
 * ADR 0555 P1 — the version-neutral isolated-worker contract.
 *
 * This module owns the SHAPES that cross the isolation boundary and nothing
 * else: no transport, no policy, no host state. A worker implementation (P2's
 * real adapter, the fake adapter here, a future WASM ABI) is "conforming" iff it
 * speaks exactly these three messages:
 *
 *     host → worker    DispatchEnvelope        (once, at dispatch)
 *     worker → host    HostCallRequest         (n times, during execution)
 *     host → worker    HostCallResponse
 *     worker → host    DispatchResultSubmission (once, terminal)
 *
 * ── WHY THE ENVELOPE CARRIES DATA AND NOT CAPABILITIES ────────────────────
 *
 * A pack node is invoked in-process today as `fn(ctx)` where `ctx` is a live
 * `NodeContext` carrying host-capability FUNCTIONS (`packs/tarballLoader.ts`).
 * Functions do not cross a process boundary, so the contract's whole content is
 * the decision about which `NodeContext` members become serializable DATA and
 * which become host-call RPC. Anything that is neither is silently unavailable
 * inside the worker, and a pack that relies on it fails only in isolation —
 * the worst place to discover it. The split is therefore written down (ADR 0555
 * P1 § "The split") rather than left implicit in whatever the runner happened
 * to project.
 *
 * ── THE HOST IS AUTHORITATIVE PER DISPATCH ────────────────────────────────
 *
 * Signing the envelope the host SENDS detects a worker tampering with its own
 * inputs, which is weak: a compromised worker can lie about the result instead.
 * So the binding runs the other way. Every host-call and the terminal result
 * present a per-dispatch bearer `token`; the host looks the dispatch up BY ID in
 * `packDispatchRegistry` and reads tenant / run / node / pack / authority from
 * ITS OWN record. Worker-supplied ids are never trusted for a decision — they
 * exist in the envelope so the pack can read them, not so the host can.
 *
 * ── `secrets` IS NOT IN THE ENVELOPE, EVER ────────────────────────────────
 *
 * `NodeContext.secrets` is CLEARTEXT BYOK material. The whole point of
 * `ctx.callAI` is that "the cleartext API key never crosses the call boundary
 * back into the node" (`executor/types.ts`), and shipping the same material to
 * an isolated worker would hand it to exactly the code the isolation exists to
 * contain. Isolated mode declares `secrets` UNSUPPORTED: a pack that declares
 * `secrets.resolveInPack` is refused at dispatch with `pack_isolation_ineligible`
 * rather than run with an empty bag (see `packIsolationPolicy.ts`).
 */

import type { PackTrustTier } from './packTrust.js';

/** Bumped when a field's MEANING changes, never when one is added. A worker
 *  that does not recognise the version refuses rather than guesses. */
export const DISPATCH_PROTOCOL_VERSION = 1;

/* -------------------------------------------------------------------------- *
 * Codes
 * -------------------------------------------------------------------------- */

/**
 * The closed grammar every failure code crossing the boundary must match.
 *
 * Deliberately lowercase-only: Node's errno codes (`ENOENT`, `ECONNREFUSED`)
 * are SCREAMING_SNAKE, so the grammar itself is what stops a host-side
 * filesystem/socket error code leaking to the run event log through the broker.
 * The executor's catch makes the same choice by allowlisting error CLASSES
 * "rather than generalising to any `.code`, which would leak internal codes like
 * Node's `ENOENT` to the wire" — this is that rule, expressed as a shape.
 */
export const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

/** Hard cap on a failure message crossing the boundary. A worker cannot make
 *  the host's log line unbounded. */
export const MAX_FAILURE_MESSAGE_CHARS = 2000;

/**
 * Normalise a pack-thrown error code for the wire.
 *
 * Packs are inconsistent about case — `tarballLoader.ts` already matches
 * `host_capability_missing` case-insensitively for exactly this reason — so the
 * code is lowercased BEFORE the grammar check. Returns `null` when the result
 * is still not a legal code, which the host turns into a typed rejection rather
 * than passing an arbitrary string through.
 */
export function normalizeFailureCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const lowered = raw.toLowerCase();
  return FAILURE_CODE_PATTERN.test(lowered) ? lowered : null;
}

/** Truncate a message to the wire cap, marking that it was cut. */
export function clampFailureMessage(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : String(raw);
  return text.length <= MAX_FAILURE_MESSAGE_CHARS
    ? text
    : `${text.slice(0, MAX_FAILURE_MESSAGE_CHARS)}… [truncated]`;
}

/** Why the host refused a worker-presented dispatch id + token. */
export const DISPATCH_REFUSALS = [
  'dispatch_unknown',
  'dispatch_token_invalid',
  'dispatch_expired',
  'dispatch_completed',
  'dispatch_cancelled',
  'dispatch_budget_exceeded',
] as const;
export type DispatchRefusal = (typeof DISPATCH_REFUSALS)[number];

/** Why the host refused an otherwise-authenticated RESULT. */
export const RESULT_REJECTIONS = [
  'result_too_large',
  'result_malformed',
  'result_error_code_invalid',
] as const;
export type ResultRejection = (typeof RESULT_REJECTIONS)[number];

/** Codes the broker itself originates (never a pack's). */
export const BROKER_ERROR_CODES = [
  'host_capability_denied',
  'host_capability_missing',
  'host_result_not_serializable',
  'host_call_arguments_not_serializable',
] as const;
export type BrokerErrorCode = (typeof BROKER_ERROR_CODES)[number];

/** The node-failure code for a pack that cannot be isolated but must be. */
export const ISOLATION_INELIGIBLE_CODE = 'pack_isolation_ineligible';
/** The node-failure code for a dispatch that outlived its wall-clock budget. */
export const ISOLATION_TIMEOUT_CODE = 'pack_isolation_timeout';

/* ── ADR 0555 P2 — codes a REAL adapter can produce and a fake one cannot ── */

/** No isolation adapter can run this dispatch (no worker artifact, no adapter
 *  configured). A REFUSAL: the host never falls back to a weaker placement. */
export const ISOLATION_ADAPTER_UNAVAILABLE_CODE = 'pack_isolation_adapter_unavailable';
/** The pack's trust tier requires containment this adapter does not enforce.
 *  Also a refusal — a tier is never downgraded to fit the adapter it has. */
export const ISOLATION_GUARANTEE_UNMET_CODE = 'pack_isolation_guarantee_unmet';
/** The isolate died without submitting a result (crash, abort, killed). */
export const ISOLATION_WORKER_CRASHED_CODE = 'pack_isolation_worker_crashed';
/** The isolate exceeded its heap ceiling and was terminated by the runtime. */
export const ISOLATION_MEMORY_CODE = 'pack_isolation_memory_exceeded';
/**
 * The configured concurrency x per-isolate heap exceeds the memory budget.
 *
 * A REFUSAL, and deliberately not a warning: over-budget isolates do not fail
 * the pack, they OOM-kill the CONTAINER, which presents as the host restarting
 * under load and sends an operator looking anywhere but at a pack knob.
 */
export const ISOLATION_BUDGET_UNSAFE_CODE = 'pack_isolation_budget_unsafe';

/* -------------------------------------------------------------------------- *
 * Provenance + eligibility, stamped by the pack loader
 * -------------------------------------------------------------------------- */

/** Why a pack node cannot be executed under isolation. Closed — a new member is
 *  a decision about the contract, not a free-form note. */
export type IsolationIneligibility =
  /** Declares `secrets.resolveInPack`; cleartext BYOK never enters a worker. */
  | 'secrets_unsupported'
  /** Uses a host surface that takes a CALLBACK (`ctx.mcp.subscribeResource`),
   *  which the request/response contract cannot express. */
  | 'callback_stream_unsupported';

export type IsolationEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: IsolationIneligibility };

/**
 * What the loader knows about a registered node's PACK. Absent on host built-in
 * node modules, and that absence is the signal that they are never isolated:
 * built-ins are this host's own code, not third-party code the tier model has an
 * opinion about.
 */
export interface PackNodeOrigin {
  readonly packName: string;
  readonly packVersion: string;
  readonly packDir: string;
  /** `file://` URL of the pack's runtime entry — how P2's real worker loads the
   *  module without the host having imported it first. */
  readonly entryUrl: string;
  readonly typeId: string;
  readonly tier: PackTrustTier;
  readonly isolation: IsolationEligibility;
}

/* -------------------------------------------------------------------------- *
 * host → worker: the dispatch envelope
 * -------------------------------------------------------------------------- */

export interface DispatchBudget {
  /** Wall-clock ceiling for the whole dispatch. */
  readonly wallClockMs: number;
  /** Ceiling on brokered host-calls. */
  readonly maxHostCalls: number;
  /** Ceiling on the serialized terminal result. */
  readonly maxResultBytes: number;
}

/** A pack's `ctx.variables.set` observed inside the worker, replayed host-side. */
export interface VariableWrite {
  readonly name: string;
  readonly value: unknown;
}

export interface DispatchEnvelope {
  readonly protocol: typeof DISPATCH_PROTOCOL_VERSION;
  readonly dispatchId: string;
  /** Per-dispatch bearer. Presented on every host-call and on the result. NOT a
   *  workload JWT — see `packDispatchRegistry.ts` for why. */
  readonly token: string;

  // ── what to run ────────────────────────────────────────────────────────
  readonly typeId: string;
  readonly packName: string;
  readonly packVersion: string;
  readonly entryUrl: string;

  // ── NodeContext data members (verbatim; the pack reads these) ───────────
  readonly runId: string;
  readonly nodeId: string;
  readonly tenantId: string;
  readonly scopeId?: string;
  readonly inputs: unknown;
  readonly config?: Record<string, unknown>;
  readonly nodeAgent?: Record<string, unknown>;
  readonly configurable: Record<string, unknown>;
  readonly triggerData?: unknown;
  readonly attempt: number;
  /**
   * ALWAYS `'untrusted'` under isolation, regardless of the run's own
   * `run.metadata.trustBoundary`.
   *
   * This is a deliberate WIDENING, not a copy. In-process the field describes
   * where the node's INPUTS came from; an isolated node is additionally running
   * code this host does not vouch for, and a pack that forwards its own output
   * into a model context should fence it either way. The direction is
   * one-way-safe: more `<UNTRUSTED>` fencing is never a security regression,
   * whereas inheriting `'trusted'` from the run would let untrusted code
   * launder content through a trusted marker.
   */
  readonly trustBoundary: 'untrusted';
  readonly interactiveSession?: boolean;
  readonly compaction?: Record<string, unknown>;
  readonly userId?: string;
  readonly actingUserId?: string;

  // ── isolation-specific ─────────────────────────────────────────────────
  readonly budget: DispatchBudget;
  /**
   * The host-call surface this dispatch may reach, as `'surface.method'` (or a
   * bare `'method'` for a top-level `NodeContext` function). Enumerated per
   * dispatch from the LIVE ctx, so a surface the executor did not wire is not
   * merely denied — it is not named.
   */
  readonly capabilityGrant: readonly string[];
  /** `ctx.variables` snapshot; the worker reads it synchronously and returns
   *  its writes with the result (`variablesWrites`). */
  readonly variablesSnapshot: Record<string, unknown>;
  /** Seeded interrupt resolution on a resume re-invoke (`makeSuspendFn`). */
  readonly suspendResolution?: { readonly resumeKey: string; readonly value: unknown };
}

/* -------------------------------------------------------------------------- *
 * worker → host: a brokered host call
 * -------------------------------------------------------------------------- */

export interface HostCallRequest {
  readonly dispatchId: string;
  readonly token: string;
  /** Monotonic per dispatch. Not used for auth — it exists so a host log can
   *  order a worker's calls without trusting a clock. */
  readonly seq: number;
  /** Dotted surface path (`'storage.kv'`, `'features.crm'`), or `''` for a
   *  top-level `NodeContext` function such as `emit`. */
  readonly surface: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

export type HostCallResponse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/* -------------------------------------------------------------------------- *
 * worker → host: the terminal result
 * -------------------------------------------------------------------------- */

/**
 * A closed three-arm union mirroring `NodeOutcome`, with `suspended` as a
 * FIRST-CLASS ARM rather than an exception.
 *
 * In-process, `ctx.suspend` throws a `SuspendSignal` that `tarballLoader.ts`
 * deliberately rethrows so the executor converts it to a suspended outcome.
 * Across a boundary an exception is just a serialized value, so without an
 * explicit arm every HITL interrupt would degrade into `pack_node_error` and the
 * run would FAIL where it should PAUSE.
 */
export type DispatchResult =
  | {
      readonly status: 'success';
      readonly outputs: Record<string, unknown>;
      readonly variablesWrites: readonly VariableWrite[];
    }
  | {
      readonly status: 'failure';
      readonly error: { readonly code: string; readonly message: string };
      readonly variablesWrites: readonly VariableWrite[];
    }
  | {
      readonly status: 'suspended';
      readonly interrupt: {
        readonly kind: string;
        readonly resumeKey: string;
        readonly data: Record<string, unknown>;
        readonly resumeSchema?: Record<string, unknown>;
        readonly timeoutMs?: number;
      };
      readonly variablesWrites: readonly VariableWrite[];
    };

export interface DispatchResultSubmission {
  readonly dispatchId: string;
  readonly token: string;
  readonly result: DispatchResult;
}

/* -------------------------------------------------------------------------- *
 * Serializability
 * -------------------------------------------------------------------------- */

/** Thrown by `assertStructuredCloneSafe`. Carries a wire-legal `.code`. */
export class NotSerializableError extends Error {
  readonly code: string;
  constructor(label: string, code: string, cause: unknown) {
    super(`${label} is not structured-clone safe: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'NotSerializableError';
    this.code = code;
  }
}

/**
 * Prove a value can cross a real process boundary.
 *
 * `structuredClone` is the exact predicate `postMessage` applies, so a value
 * that clones here is one a `worker_threads`/`MessagePort` transport can carry —
 * and one that does not (a live `Response` from `ctx.http.safeFetch`, a class
 * instance with methods, a function) fails HERE, in the fake adapter, with a
 * typed error, rather than in P2 as an opaque `DataCloneError` from the runtime.
 *
 * Returns the CLONE, not the input: using the copy is what makes the fake
 * adapter a real message boundary rather than a shared-object call.
 *
 * LIMIT, MEASURED, and stated because it would otherwise read as a guard that
 * catches more than it does: `structuredClone` does NOT throw on an ordinary
 * class instance. It drops the prototype and keeps the own data properties, so
 * a host seam returning an object with BEHAVIOUR on its prototype crosses the
 * boundary as a plain object whose methods are silently gone. A real
 * `postMessage` transport does exactly the same, so this is faithful rather
 * than lenient — but it means the only reliable protection for such a surface
 * is `NEVER_BROKERED`, not this predicate. `pack-worker-runner.test.ts` pins
 * both halves (a `Response` throws; a class instance is silently flattened).
 */
export function assertStructuredCloneSafe<T>(value: T, label: string, code: string): T {
  try {
    return structuredClone(value);
  } catch (err) {
    throw new NotSerializableError(label, code, err);
  }
}

/** Serialized size of a terminal result, in bytes, for the budget check. */
export function resultByteLength(result: DispatchResult): number {
  return Buffer.byteLength(JSON.stringify(result) ?? '', 'utf-8');
}
