/**
 * ADR 0555 P1 — the per-dispatch capability record.
 *
 * The host is authoritative per dispatch. This registry is where that authority
 * lives: one record per in-flight isolated node execution, keyed by an opaque
 * `dispatchId` and guarded by a 256-bit bearer `token`. Everything the host
 * needs to decide a brokered host-call — the run's effect context, its
 * authority facts, the capability grant, the budget — is read from HERE, never
 * from the message the worker sent. A worker can lie about its tenant, run,
 * node or pack; it cannot make the host look those up anywhere but its own row.
 *
 * ── WHY A HOST-LOCAL RANDOM BEARER AND NOT THE WORKLOAD JWT ───────────────
 *
 * `host/workloadIdentity.ts` mints short-lived HS256 credentials, and reusing
 * one here would look like consolidation. It would be the wrong instrument:
 *
 *   - Its `aud` is HOST-GLOBAL and its claims carry no run/node/pack. A
 *     workload credential says "some worker of this host"; the thing that must
 *     be authenticated here is "THIS dispatch of THIS node". A per-dispatch
 *     claim set would mean minting a new JWT shape, i.e. a second identity
 *     scheme wearing the first one's name.
 *   - Its `jti` is never consumed, so it is replayable within its TTL by
 *     design. The result channel here must be SINGLE-USE (the CAS below) or a
 *     worker could submit a second, different outcome for a completed node.
 *   - It is a cross-process identity assertion verified against a trust root.
 *     This is a process-local capability handle with no verifier outside the
 *     minting process, and pretending otherwise would advertise a property the
 *     mechanism does not have.
 *
 * Workload identity is still used — for ATTRIBUTION, not authentication. The
 * record carries the run's RECORDED `AuthorityFacts` when it has them, else a
 * minted-and-round-tripped `worker/pack-isolate` identity, exactly as
 * `runDispatchSweeper.ts` does for a re-dispatch. Same helper, same order,
 * `null` when the profile is not configured.
 *
 * ── LIFECYCLE ─────────────────────────────────────────────────────────────
 *
 *   issue()   → `pending`, with an expiry = the dispatch's wall-clock budget
 *   verify()  → the record, or a typed refusal (unknown / bad token / expired /
 *               already terminal / cancelled)
 *   complete()→ CAS `pending` → `completed | failed | suspended`. The CAS is
 *               what makes a REPLAYED ENVELOPE inert: the second dispatch
 *               presents a token whose record is no longer `pending`.
 *   cancel()  → `cancelled`; every later host-call is refused.
 *
 * The map is process-local and bounded by completion + a sweep, because a
 * dispatch outlives neither the node execution that created it nor its budget.
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../observability/logger.js';
import type { AuthorityFacts } from './authorityContext.js';
import type { RunEffectContext } from './runEffectContext.js';
import type { DispatchBudget, DispatchRefusal } from './packWorkerContract.js';

const log = createLogger('host.packDispatchRegistry');

export type DispatchState = 'pending' | 'completed' | 'failed' | 'suspended' | 'cancelled';

/** The terminal states a result submission may CAS into. */
export type DispatchTerminal = Extract<DispatchState, 'completed' | 'failed' | 'suspended'>;

export interface DispatchRecord {
  readonly dispatchId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly tenantId: string;
  readonly typeId: string;
  readonly packName: string;
  readonly packVersion: string;
  /** Re-established around EVERY brokered host-call. This is what makes the
   *  ADR 0531 guard survive a boundary AsyncLocalStorage cannot cross. */
  readonly effectCtx: RunEffectContext;
  /** Attribution only (ADR 0556 P3 / RFC 0154 §D). `null` when the workload
   *  identity profile is not configured — a host that advertises nothing must
   *  not act as if it had an identity layer. */
  readonly authority: AuthorityFacts | null;
  readonly grant: ReadonlySet<string>;
  readonly budget: DispatchBudget;
  readonly expiresAtMs: number;
  state: DispatchState;
  hostCalls: number;
}

export interface IssueDispatchInput {
  readonly runId: string;
  readonly nodeId: string;
  readonly tenantId: string;
  readonly typeId: string;
  readonly packName: string;
  readonly packVersion: string;
  readonly effectCtx: RunEffectContext;
  readonly authority: AuthorityFacts | null;
  readonly grant: ReadonlySet<string>;
  readonly budget: DispatchBudget;
  /** Injectable for tests; defaults to `Date.now()`. */
  readonly nowMs?: number;
}

export type DispatchLookup =
  | { readonly ok: true; readonly record: DispatchRecord }
  | { readonly ok: false; readonly refusal: DispatchRefusal };

interface StoredDispatch {
  readonly record: DispatchRecord;
  /** SHA-256 of the token. The plaintext is handed out once and never kept, so
   *  a heap dump of the host does not yield live dispatch bearers. */
  readonly tokenHash: Buffer;
}

const dispatches = new Map<string, StoredDispatch>();

/** Bound on retained records. A dispatch is removed on completion; this only
 *  catches the pathological case of a host that issues and never completes. */
const MAX_TRACKED_DISPATCHES = 10_000;

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf-8').digest();
}

/**
 * Constant-time token comparison.
 *
 * Compares the SHA-256 digests rather than the raw strings so the inputs are
 * always the same length — `timingSafeEqual` THROWS on a length mismatch, and
 * catching that throw would itself be a length oracle.
 */
function tokenMatches(presented: string, expected: Buffer): boolean {
  return timingSafeEqual(hashToken(presented), expected);
}

export interface IssuedDispatch {
  readonly dispatchId: string;
  /** Handed to the worker in the envelope. The registry keeps only its hash. */
  readonly token: string;
  readonly record: DispatchRecord;
}

export function issueDispatch(input: IssueDispatchInput): IssuedDispatch {
  const now = input.nowMs ?? Date.now();
  const dispatchId = `pd_${randomBytes(16).toString('base64url')}`;
  const token = randomBytes(32).toString('base64url');
  const record: DispatchRecord = {
    dispatchId,
    runId: input.runId,
    nodeId: input.nodeId,
    tenantId: input.tenantId,
    typeId: input.typeId,
    packName: input.packName,
    packVersion: input.packVersion,
    effectCtx: input.effectCtx,
    authority: input.authority,
    grant: input.grant,
    budget: input.budget,
    expiresAtMs: now + input.budget.wallClockMs,
    state: 'pending',
    hostCalls: 0,
  };
  dispatches.set(dispatchId, { record, tokenHash: hashToken(token) });
  sweep(now);
  return { dispatchId, token, record };
}

/**
 * Authenticate a worker-presented `(dispatchId, token)` pair.
 *
 * Order matters: unknown id → bad token → expired → terminal. Each answer is a
 * distinct typed refusal because they mean different things to an operator, and
 * none of them reveals anything a caller holding the right token could not
 * already learn.
 */
export function verifyDispatch(dispatchId: unknown, token: unknown, nowMs = Date.now()): DispatchLookup {
  if (typeof dispatchId !== 'string' || typeof token !== 'string') {
    return { ok: false, refusal: 'dispatch_unknown' };
  }
  const stored = dispatches.get(dispatchId);
  if (!stored) return { ok: false, refusal: 'dispatch_unknown' };
  if (!tokenMatches(token, stored.tokenHash)) {
    log.warn('pack dispatch token mismatch', { dispatchId, runId: stored.record.runId });
    return { ok: false, refusal: 'dispatch_token_invalid' };
  }
  if (stored.record.state === 'cancelled') return { ok: false, refusal: 'dispatch_cancelled' };
  if (stored.record.state !== 'pending') return { ok: false, refusal: 'dispatch_completed' };
  if (nowMs > stored.record.expiresAtMs) return { ok: false, refusal: 'dispatch_expired' };
  return { ok: true, record: stored.record };
}

/**
 * Charge one brokered host-call against the budget.
 *
 * Counted on the way IN, before the seam runs, so a worker cannot exceed the
 * ceiling by racing: the (N+1)th call is refused whether or not the Nth has
 * returned.
 */
export function chargeHostCall(record: DispatchRecord): DispatchLookup {
  if (record.hostCalls >= record.budget.maxHostCalls) {
    return { ok: false, refusal: 'dispatch_budget_exceeded' };
  }
  record.hostCalls += 1;
  return { ok: true, record };
}

/**
 * CAS the dispatch to a terminal state.
 *
 * This single-use transition is the whole anti-replay property: a second
 * dispatch of the same envelope, or a second result for the same dispatch,
 * finds the record non-`pending` and is refused. It is deliberately NOT
 * "last write wins" — a worker that can overwrite a recorded outcome can
 * rewrite the run's history.
 */
export function completeDispatch(
  dispatchId: unknown,
  token: unknown,
  terminal: DispatchTerminal,
  nowMs = Date.now(),
): DispatchLookup {
  const lookup = verifyDispatch(dispatchId, token, nowMs);
  if (!lookup.ok) return lookup;
  lookup.record.state = terminal;
  return lookup;
}

/** Kill a dispatch. Idempotent; a terminal record stays terminal. */
export function cancelDispatch(dispatchId: string): void {
  const stored = dispatches.get(dispatchId);
  if (!stored) return;
  if (stored.record.state === 'pending') stored.record.state = 'cancelled';
}

/** Drop a finished dispatch's row. Called by the dispatcher's `finally`. */
export function releaseDispatch(dispatchId: string): void {
  dispatches.delete(dispatchId);
}

/** Read a record WITHOUT presenting a token — host-side introspection only
 *  (tests, the dispatcher's own bookkeeping). Never reachable from a worker. */
export function peekDispatch(dispatchId: string): DispatchRecord | null {
  return dispatches.get(dispatchId)?.record ?? null;
}

function sweep(nowMs: number): void {
  if (dispatches.size <= MAX_TRACKED_DISPATCHES) return;
  for (const [id, stored] of dispatches) {
    if (stored.record.state !== 'pending' || nowMs > stored.record.expiresAtMs) {
      dispatches.delete(id);
    }
    if (dispatches.size <= MAX_TRACKED_DISPATCHES) break;
  }
}

/** Test seam — clears every record so suites do not inherit each other's rows. */
export function __resetPackDispatchRegistryForTests(): void {
  dispatches.clear();
}
