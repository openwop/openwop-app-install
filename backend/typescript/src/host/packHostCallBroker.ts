/**
 * ADR 0555 P1 — the host-call broker: a PROJECTION of one live `NodeContext`.
 *
 * The broker is constructed by the executor with the very `ctx` object the
 * in-process path would have handed the pack. It does not rebuild, wrap or
 * re-implement a single host surface; it exposes a NAMED SUBSET of that object
 * over the `(surface, method, args)` request shape. That is the property the
 * whole design leans on: a brokered `ctx.storage.kv.put` and an in-process
 * `ctx.storage.kv.put` are the same function, called with the same arguments,
 * so there is no second implementation to drift.
 *
 * ── GUARD PROPAGATION IS HOST-SIDE, AND THAT IS THE POINT ─────────────────
 *
 * `host/runEffectContext.ts` states the tripwire for this whole program in its
 * header: AsyncLocalStorage propagates through `await` but NOT across a process
 * boundary, so "if pack execution ever moves out-of-process … this backstop
 * degrades SILENTLY to no guard and the host side of that boundary must
 * re-establish it."
 *
 * This is that re-establishment, and it is deliberately structural rather than
 * remembered: EVERY brokered call is wrapped in
 * `runWithEffectContext(record.effectCtx, () => runWithAuthority(record.authority, seam))`,
 * so `assertEffectAllowed` fires at the identical seam with the identical kind,
 * `observedEffectKinds` fills from the identical allow branch, and
 * `recordAuthorityAction` records the identical facts. There is ONE wrapper, at
 * ONE place, around ONE dispatcher — a seam cannot be added to the isolated path
 * without going through it.
 *
 * The isolated execution itself runs OUTSIDE the executor's
 * `runWithEffectContext`, on purpose. Nesting it would let the fake in-process
 * adapter inherit the ambient context and make the sabotage test (delete this
 * wrapper ⇒ a replayed effect FIRES) pass vacuously — the fake boundary must be
 * as blind to ALS as a real worker process is.
 *
 * ── NEVER-BROKERED MEMBERS ────────────────────────────────────────────────
 *
 * Four `NodeContext` members are excluded from every grant, for three different
 * reasons, all of them about what the contract can honestly express:
 *
 *   `secrets`               cleartext BYOK; never crosses into a worker at all.
 *   `variables`             SYNChronous `get`/`set`; a `Promise` cannot preserve
 *                           that, so it rides as a snapshot + write-behind.
 *   `interrupt` / `suspend` control flow, not a call; realised worker-side as a
 *                           `suspended` result arm.
 *   `mcp.subscribeResource` takes a CALLBACK; a request/response contract cannot
 *                           carry a function. Packs declaring it are refused at
 *                           dispatch, not silently degraded.
 *   `http.safeFetch`        returns a live `Response` (methods, streams), which
 *                           `structuredClone` cannot carry. Denied rather than
 *                           mangled into a plain object that would lie about its
 *                           own shape.
 */

import { createLogger } from '../observability/logger.js';
import { runWithAuthority } from './authorityContext.js';
import { runWithEffectContext } from './runEffectContext.js';
import { setRunVariable } from './variablesRuntime.js';
import {
  chargeHostCall,
  completeDispatch,
  verifyDispatch,
  type DispatchRecord,
} from './packDispatchRegistry.js';
import {
  FAILURE_CODE_PATTERN,
  NotSerializableError,
  assertStructuredCloneSafe,
  clampFailureMessage,
  normalizeFailureCode,
  resultByteLength,
  type DispatchRefusal,
  type DispatchResult,
  type DispatchResultSubmission,
  type HostCallRequest,
  type HostCallResponse,
  type ResultRejection,
} from './packWorkerContract.js';
import type { NodeContext } from '../executor/types.js';

const log = createLogger('host.packHostCallBroker');

/**
 * `NodeContext` members that are DATA (they ride in the envelope) and must
 * never be walked for callable leaves. Closed and mirrored by
 * `DispatchEnvelope` — a member here that is not in the envelope is a member the
 * worker cannot see at all.
 */
const ENVELOPE_DATA_MEMBERS: ReadonlySet<string> = new Set([
  'runId', 'nodeId', 'tenantId', 'scopeId', 'inputs', 'config', 'nodeAgent',
  'configurable', 'triggerData', 'attempt', 'trustBoundary', 'interactiveSession',
  'compaction', 'userId', 'actingUserId',
]);

/** Members excluded from EVERY grant. See the file header for why each. */
export const NEVER_BROKERED: readonly string[] = [
  'secrets',
  'variables',
  'interrupt',
  'suspend',
  'mcp.subscribeResource',
  'http.safeFetch',
];
const neverBrokered = new Set(NEVER_BROKERED);

/** How deep a `NodeContext` surface nests (`storage.kv.get`, `features.crm.list`). */
const MAX_SURFACE_DEPTH = 3;

/**
 * Enumerate the callable host surface of ONE live ctx, as grant keys.
 *
 * Structural rather than an allowlist, deliberately. A hand-kept list of
 * brokerable surfaces is a second registry beside `NodeContext` itself, and
 * this repo has already paid for that shape twice (the ADR 0341 typeId
 * allowlist that 55 nodes drifted off; the three node-rebuilding validator
 * allowlists that silently dropped new wire fields). Walking the object means a
 * surface the executor wired is granted because it is THERE, and a surface it
 * did not wire is not named at all.
 *
 * `ctx.features` is walked on every dispatch for the same reason: it is an OPEN
 * per-tenant namespace that features register into at boot, so any snapshot of
 * it would be a snapshot of one moment's registry.
 */
export function enumerateCtxGrant(ctx: NodeContext): Set<string> {
  const grant = new Set<string>();
  walk(ctx as unknown as Record<string, unknown>, '', 1, grant);
  return grant;
}

function walk(node: Record<string, unknown>, prefix: string, depth: number, out: Set<string>): void {
  for (const [key, value] of Object.entries(node)) {
    if (depth === 1 && ENVELOPE_DATA_MEMBERS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (neverBrokered.has(path)) continue;
    if (typeof value === 'function') {
      out.add(path);
      continue;
    }
    if (depth < MAX_SURFACE_DEPTH && value && typeof value === 'object' && !Array.isArray(value)) {
      walk(value as Record<string, unknown>, path, depth + 1, out);
    }
  }
}

/**
 * Narrow a grant by a node module's declared `requires`.
 *
 * > **CORRECTION (P1 implementation).** The architect decision specified the
 * > grant as `pack requires ∩ ctx members ∩ tenant toggles`. Taken literally
 * > that yields the EMPTY set for every pack in this repo and no isolated pack
 * > could call anything: `packs/tarballLoader.ts` never stamps
 * > `NodeModule.requires`, and the manifests that do declare `requires` use
 * > HOST-CAPABILITY keys (`net.dns`, `net.outbound`) that are not ctx members
 * > at all. So the intersection is applied only over entries that NAME a ctx
 * > surface; a `requires` entry that names a host capability is left to
 * > `hasCapability()`, which already gates it in the executor, and a module
 * > with no ctx-naming `requires` gets the full enumerated surface.
 * >
 * > The tenant-toggle half is NOT re-evaluated here either, and that is a
 * > decision rather than an omission: `host/featureSurfaces.ts` already wraps
 * > every `ctx.features.<id>.<method>` in a per-call toggle gate that throws
 * > `host_capability_disabled`, and the broker propagates that verbatim. A
 * > second toggle evaluation in the grant would be a second allowlist over the
 * > same fact — the exact drift shape this file's enumeration exists to avoid.
 */
export function narrowGrantByRequires(grant: Set<string>, requires: readonly string[] | undefined): Set<string> {
  if (!requires || requires.length === 0) return grant;
  const ctxNaming = requires.filter((r) => grant.has(r) || [...grant].some((g) => g.startsWith(`${r}.`)));
  if (ctxNaming.length === 0) return grant;
  const narrowed = new Set<string>();
  for (const key of grant) {
    if (ctxNaming.some((r) => key === r || key.startsWith(`${r}.`))) narrowed.add(key);
  }
  return narrowed;
}

export type SubmitOutcome =
  | { readonly accepted: true; readonly result: DispatchResult }
  | { readonly accepted: false; readonly refusal: DispatchRefusal | ResultRejection };

export interface PackHostCallBroker {
  readonly dispatchId: string;
  /** Serve one worker-originated host call. Never throws — a refusal is a
   *  `{ok:false}` response, so a worker cannot distinguish "denied" from
   *  "crashed the host". */
  hostCall(req: HostCallRequest): Promise<HostCallResponse>;
  /** Accept (or refuse) the terminal result. Single-use via the registry CAS. */
  submitResult(submission: DispatchResultSubmission): SubmitOutcome;
}

export function createPackHostCallBroker(input: {
  readonly dispatchId: string;
  readonly ctx: NodeContext;
  readonly grant: ReadonlySet<string>;
}): PackHostCallBroker {
  const { dispatchId, ctx } = input;

  return {
    dispatchId,

    async hostCall(req: HostCallRequest): Promise<HostCallResponse> {
      // The host looks the dispatch up BY ID and reads tenant/run/node/pack and
      // the grant from ITS OWN record. Nothing below reads those from `req`.
      const lookup = verifyDispatch(req?.dispatchId, req?.token);
      if (!lookup.ok) return refused(lookup.refusal, `dispatch refused: ${lookup.refusal}`);
      const record = lookup.record;
      if (req.dispatchId !== dispatchId) {
        // A valid token for a DIFFERENT dispatch presented to this broker.
        return refused('dispatch_unknown', 'dispatch id does not belong to this broker');
      }
      const charged = chargeHostCall(record);
      if (!charged.ok) return refused(charged.refusal, `host-call budget exhausted (${record.budget.maxHostCalls})`);

      const key = grantKey(req.surface, req.method);
      if (!record.grant.has(key)) {
        // Refused BEFORE resolution, so the underlying seam is never touched —
        // the property the tamper test asserts by spying on the seam.
        log.warn('pack host-call outside grant', {
          dispatchId, runId: record.runId, nodeId: record.nodeId, pack: record.packName, key,
        });
        return refused('host_capability_denied', `host call '${key}' is not in this dispatch's capability grant`);
      }

      const resolved = resolveMember(ctx, req.surface, req.method);
      if (!resolved) {
        return refused('host_capability_missing', `host surface '${key}' is not wired on this host`);
      }

      let args: unknown[];
      try {
        // Arguments arrived over a message boundary; re-assert that before
        // handing them to a live host seam. A function smuggled in by a
        // same-process fake adapter dies here rather than executing.
        args = assertStructuredCloneSafe([...req.args], `host call '${key}' arguments`, 'host_call_arguments_not_serializable');
      } catch (err) {
        return errorResponse(err);
      }

      try {
        const value = await invokeUnderGuards(record, () => resolved.fn.apply(resolved.self, args) as unknown);
        // The RESULT must survive the boundary too. A live `Response` or a class
        // instance fails here, typed, instead of arriving as a mangled object.
        return { ok: true, value: assertStructuredCloneSafe(value, `host call '${key}' result`, 'host_result_not_serializable') };
      } catch (err) {
        return errorResponse(err);
      }
    },

    submitResult(submission: DispatchResultSubmission): SubmitOutcome {
      const result = submission?.result;
      if (!result || typeof result !== 'object' || typeof result.status !== 'string') {
        // Verify first so a malformed body from an UNAUTHENTICATED submitter is
        // still refused as a dispatch problem, not a parse problem.
        const auth = verifyDispatch(submission?.dispatchId, submission?.token);
        return auth.ok ? { accepted: false, refusal: 'result_malformed' } : { accepted: false, refusal: auth.refusal };
      }
      const auth = verifyDispatch(submission.dispatchId, submission.token);
      if (!auth.ok) return { accepted: false, refusal: auth.refusal };
      if (submission.dispatchId !== dispatchId) {
        return { accepted: false, refusal: 'dispatch_unknown' };
      }
      const record = auth.record;

      if (resultByteLength(result) > record.budget.maxResultBytes) {
        return { accepted: false, refusal: 'result_too_large' };
      }

      const normalized = normalizeResult(result);
      if (!normalized) return { accepted: false, refusal: 'result_error_code_invalid' };

      const terminal = normalized.status === 'success' ? 'completed' : normalized.status === 'suspended' ? 'suspended' : 'failed';
      const cas = completeDispatch(submission.dispatchId, submission.token, terminal);
      if (!cas.ok) return { accepted: false, refusal: cas.refusal };

      // ── write-behind ─────────────────────────────────────────────────────
      // Applied ONLY on success. In-process a node's `ctx.variables.set` lands
      // the moment it is called, so a node that fails midway leaves its partial
      // writes behind; isolation makes that atomic instead. The difference is
      // deliberate and is recorded in ADR 0555 as a pack-facing consequence: a
      // failed or suspended isolated node contributes NO variable writes.
      if (normalized.status === 'success') {
        for (const write of normalized.variablesWrites) {
          setRunVariable(record.runId, write.name, write.value);
        }
      }
      return { accepted: true, result: normalized };
    },
  };
}

/* -------------------------------------------------------------------------- *
 * internals
 * -------------------------------------------------------------------------- */

export function grantKey(surface: string, method: string): string {
  return surface ? `${surface}.${method}` : method;
}

interface ResolvedMember {
  readonly self: unknown;
  readonly fn: (...args: unknown[]) => unknown;
}

function resolveMember(ctx: NodeContext, surface: unknown, method: unknown): ResolvedMember | null {
  if (typeof method !== 'string' || method.length === 0) return null;
  if (typeof surface !== 'string') return null;
  let self: unknown = ctx;
  if (surface.length > 0) {
    for (const part of surface.split('.')) {
      if (!self || typeof self !== 'object') return null;
      if (!Object.prototype.hasOwnProperty.call(self, part)) return null;
      self = (self as Record<string, unknown>)[part];
    }
  }
  if (!self || typeof self !== 'object') return null;
  const fn = (self as Record<string, unknown>)[method];
  return typeof fn === 'function' ? { self, fn: fn as (...args: unknown[]) => unknown } : null;
}

/**
 * The ONE place the two ambient contexts are re-established.
 *
 * `runWithAuthority` is applied only when the record HAS authority facts —
 * fabricating them for a host with no workload-identity profile would make the
 * record say something false (`recordAuthorityAction`'s own rule).
 */
async function invokeUnderGuards<T>(record: DispatchRecord, seam: () => T): Promise<Awaited<T>> {
  return await runWithEffectContext(record.effectCtx, () =>
    record.authority ? runWithAuthority(record.authority, seam) : seam(),
  );
}

function refused(code: string, message: string): HostCallResponse {
  return { ok: false, error: { code, message } };
}

/**
 * Map a thrown host-seam error onto a wire code.
 *
 * The grammar IS the filter. `AiProviderError`, `McpError` and
 * `ReplayEffectError` — the three classes the executor allowlists — all carry
 * lowercase snake codes, so matching the pattern reproduces that allowlist
 * exactly; it additionally preserves the host surfaces' own codes
 * (`host_capability_disabled`, `connector_no_connection`), which the in-process
 * path already surfaces through the loader's any-`.code` rule. Node's errno
 * codes are SCREAMING_SNAKE and therefore cannot match, which is the leak the
 * executor's comment warns about.
 */
function errorResponse(err: unknown): HostCallResponse {
  const message = clampFailureMessage(err instanceof Error ? err.message : String(err));
  if (err instanceof NotSerializableError) return refused(err.code, message);
  const raw = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  const code = typeof raw === 'string' && FAILURE_CODE_PATTERN.test(raw) ? raw : 'internal_error';
  return refused(code, message);
}

/** Validate + normalise a worker result. `null` ⇒ reject the whole submission. */
function normalizeResult(result: DispatchResult): DispatchResult | null {
  const writes = Array.isArray(result.variablesWrites)
    ? result.variablesWrites.filter((w): w is { name: string; value: unknown } => Boolean(w) && typeof w.name === 'string')
    : [];
  if (result.status === 'success') {
    const outputs = result.outputs && typeof result.outputs === 'object' ? result.outputs : {};
    return { status: 'success', outputs, variablesWrites: writes };
  }
  if (result.status === 'suspended') {
    const it = result.interrupt;
    if (!it || typeof it.kind !== 'string' || typeof it.resumeKey !== 'string') return null;
    return {
      status: 'suspended',
      interrupt: {
        kind: it.kind,
        resumeKey: it.resumeKey,
        data: it.data && typeof it.data === 'object' ? it.data : {},
        ...(it.resumeSchema !== undefined ? { resumeSchema: it.resumeSchema } : {}),
        ...(typeof it.timeoutMs === 'number' ? { timeoutMs: it.timeoutMs } : {}),
      },
      variablesWrites: writes,
    };
  }
  if (result.status === 'failure') {
    const code = normalizeFailureCode(result.error?.code);
    if (!code) return null;
    return { status: 'failure', error: { code, message: clampFailureMessage(result.error?.message) }, variablesWrites: writes };
  }
  return null;
}
