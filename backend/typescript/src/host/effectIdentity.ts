/**
 * ADR 0549 P3 — RFC 0150 §B, the Layer-2 **logical effect identity** (v2).
 *
 * ONE owner for the composition in `spec/v1/idempotency.md` §"Idempotency key
 * composition":
 *
 * ```text
 * logicalInvocationId = base64url(sha256(
 *   "openwop:activity:v2\0" ||
 *   tenantId || "\0" || runId || "\0" || nodeId || "\0" ||
 *   logicalInvocationOrdinal || "\0" || providerKey
 * ))
 * ```
 *
 * **`attempt` is deliberately absent, and that absence IS the safety property.**
 * Through `idempotency.md` v1.1 the composition was
 * `sha256(runId ':' nodeId ':' attempt ':' providerKey)`; RFC 0150 §B retired it
 * as a safety-fix because an identity that varies per attempt is not an
 * identity. It hands every retry a fresh key, so the invocation log never hits,
 * the value injected as the provider's `Idempotency-Key` differs from the one
 * the provider already saw, and the provider's own deduplication is defeated
 * along with the engine's — guaranteeing the duplicate side effect Layer 2
 * exists to prevent, on exactly the retry path it was written for.
 *
 * `attempt` remains useful telemetry and this host keeps recording it (the
 * invocation log's `attempt` column, the OTel `openwop.node_attempt` attribute),
 * but it never reaches this preimage.
 *
 * **`tenantId` is in the preimage** because without it two tenants colliding on
 * `(runId, nodeId, ordinal, providerKey)` share an invocation-log entry, and the
 * second tenant is served the first tenant's cached provider response.
 *
 * **Scope caveat (`idempotency.md` v1.4).** `runId` is in the preimage, so this
 * identity is RUN-SCOPED: it deduplicates a node's retries against each other
 * and nothing else. An effect also reachable outside a run (an operator route, a
 * scheduled job) can never produce one of these, so it can never collide with
 * one. Where that is the case the host MUST additionally key on a **business
 * identity** containing no `runId`/`nodeId`/ordinal — see
 * `features/commerce/commerceService.ts`, whose Stripe refund keys are
 * `commerce-refund:<orderId>` precisely for this reason, and
 * `test/effect-identity-v2.test.ts` § "cross-scope", which pins it.
 */

import { createHash } from 'node:crypto';

/**
 * The domain-separation tag. Present so a Layer-2 identity cannot collide with
 * any other digest the engine computes, and so a future v3 composition cannot
 * collide with this one — which is what lets v1 records be left to expire under
 * their TTL rather than migrated (`idempotency.md` §"Migration from the v1
 * composition").
 */
export const ACTIVITY_IDENTITY_RECIPE_V2 = 'openwop:activity:v2';

/** The `spec/v1/idempotency.md` §B v2 preimage fields. */
export interface LogicalEffectIdentityInput {
  /** The authenticated tenant the run belongs to. */
  readonly tenantId: string;
  /** The run ID. */
  readonly runId: string;
  /** The node ID within the run. */
  readonly nodeId: string;
  /**
   * A counter over the LOGICAL side effects this node performs, assigned once
   * when the logical activity is created.
   *
   * MUST NOT change across transport or provider retries of the same logical
   * activity. Two distinct logical invocations MUST receive different ordinals
   * even when every other input matches — a node that calls the same provider
   * twice on purpose is performing two effects, and they MUST NOT deduplicate
   * against each other.
   */
  readonly logicalInvocationOrdinal: number;
  /**
   * A stable identifier for the side effect being made. For LLM calls this host
   * uses the RFC 0150 §C semantic request digest v2
   * (`providers/llmCacheKey.ts`); for other effects it is the effect's own
   * stable name (`'stripe:create-charge'`, `'send-email'`).
   */
  readonly providerKey: string;
}

/**
 * NUL is the field separator, and the encoding is injective because NUL is not
 * representable in any field value. Enforced rather than assumed: a value
 * carrying a NUL would let two distinct tuples produce one preimage, which is
 * the one way this composition can silently collide.
 */
function assertNulFree(label: string, value: string): void {
  if (value.includes('\0')) {
    throw new Error(
      `logicalInvocationId: '${label}' contains a NUL byte, which would make the preimage ambiguous (RFC 0150 §B)`,
    );
  }
}

/**
 * Compute the RFC 0150 §B v2 logical effect identity — `base64url(sha256(...))`
 * without padding.
 *
 * Retry-stable by construction: no caller can pass an attempt counter, because
 * the input type has no field for one.
 */
export function logicalInvocationId(input: LogicalEffectIdentityInput): string {
  const { tenantId, runId, nodeId, logicalInvocationOrdinal, providerKey } = input;
  if (!Number.isInteger(logicalInvocationOrdinal) || logicalInvocationOrdinal < 0) {
    throw new Error(
      `logicalInvocationId: ordinal must be a non-negative integer, got ${String(logicalInvocationOrdinal)}`,
    );
  }
  assertNulFree('tenantId', tenantId);
  assertNulFree('runId', runId);
  assertNulFree('nodeId', nodeId);
  assertNulFree('providerKey', providerKey);
  const preimage = [
    ACTIVITY_IDENTITY_RECIPE_V2,
    tenantId,
    runId,
    nodeId,
    String(logicalInvocationOrdinal),
    providerKey,
  ].join('\0');
  return createHash('sha256').update(preimage, 'utf8').digest('base64url');
}

/**
 * Per-`(runId, nodeId, attempt)` ordinal allocator.
 *
 * The ordinal must be **retry-stable**: the first logical AI activity of a
 * node's second attempt is the SAME logical effect as the first activity of its
 * first attempt, so both must get ordinal 0. That is why the counter is keyed on
 * `(runId, nodeId)` and RESET when a new attempt of that node begins, rather
 * than running monotonically across the node's whole life — a monotonic counter
 * would smuggle the attempt back into the identity through the ordinal and
 * reintroduce exactly the defect §B retired.
 *
 * It must also be **deterministic under replay**: a replay re-executes the node
 * body and therefore issues the same sequence of activities, so it allocates the
 * same ordinals. That is the same determinism assumption replay already makes
 * about node bodies (`spec/v1/replay.md` §C observable-output-sequence
 * determinism); nothing new is being assumed here.
 *
 * Process-local. A run executes inside one process, and the ordinal only has to
 * agree between the calls of a single node execution — it is never compared
 * across processes. What IS compared across processes is the resulting identity,
 * which is a pure function of its inputs.
 */
const ordinalCounters = new Map<string, { attempt: number; next: number }>();

function ordinalScopeKey(runId: string, nodeId: string): string {
  return `${runId}\u0000${nodeId}`;
}

/**
 * Declare that a node body is about to EXECUTE, rewinding its ordinal to 0.
 *
 * The executor calls this before every node execution, and that explicit signal
 * is load-bearing rather than defensive. A node body can re-enter at the SAME
 * attempt: a HITL `SuspendSignal` unwinds out of the node, and the resume
 * re-runs the handler from the top. Without a rewind, the resumed body's first
 * AI call would be allocated ordinal 1 instead of 0 — a different identity, a
 * cache miss, and a SECOND provider call for an effect the pre-suspend body had
 * already performed. That is the duplicate effect Layer 2 exists to prevent,
 * arriving through the ordinal rather than through the retry counter.
 *
 * The `attempt !== attempt` rewind inside `nextLogicalInvocationOrdinal` is the
 * safety net for callers that drive the adapter directly (tests, and any future
 * non-executor effect site). Both paths must agree, so the state they touch is
 * the same map.
 */
export function beginNodeActivity(runId: string, nodeId: string, attempt: number): void {
  ordinalCounters.set(ordinalScopeKey(runId, nodeId), { attempt, next: 0 });
}

/**
 * Allocate the next `logicalInvocationOrdinal` for a logical activity about to
 * be created by `(runId, nodeId)` on `attempt`.
 *
 * `attempt` is passed ONLY so the counter can detect that a new attempt has
 * begun and rewind to 0. It never reaches the identity.
 */
export function nextLogicalInvocationOrdinal(runId: string, nodeId: string, attempt: number): number {
  const key = ordinalScopeKey(runId, nodeId);
  const state = ordinalCounters.get(key);
  if (!state || state.attempt !== attempt) {
    ordinalCounters.set(key, { attempt, next: 1 });
    return 0;
  }
  const ordinal = state.next;
  state.next = ordinal + 1;
  return ordinal;
}

/** Drop a run's ordinal state once the run is finished (or in tests). */
export function resetLogicalInvocationOrdinals(runId?: string): void {
  if (runId === undefined) {
    ordinalCounters.clear();
    return;
  }
  const prefix = `${runId}\u0000`;
  for (const key of [...ordinalCounters.keys()]) {
    if (key.startsWith(prefix)) ordinalCounters.delete(key);
  }
}

/**
 * The `effectId` for one Layer-2 effect, as `GET /runs/{runId}/effects` reports it.
 *
 * SHARED because two callers must agree BY CONSTRUCTION: the projection that
 * publishes the id, and `forceEffectTransportRetry`, whose 201 body returns the
 * id of the effect it just drove. A consumer follows the seam's `effectId`
 * straight into the projection, so two independent derivations would be a
 * drift the schema cannot catch — both sides are well-formed, they just name
 * different effects.
 *
 * `attempt` is DELIBERATELY ABSENT (ADR 0638). `idempotency.md` §Layer 2: the
 * effect is "identified once and stable across every transport or provider
 * retry", and "the retry counter MUST NOT participate in the identity". The
 * projection carries `attempt` as its own field, so N attempt-rows share one id.
 */
export function effectIdFor(input: { tenantId: string; runId: string; nodeId: string; invocationId: string }): string {
  const digest = createHash('sha256')
    .update(`${input.runId}\u0000${input.nodeId}\u0000${input.invocationId}`)
    .digest('hex')
    .slice(0, 32);
  return `${input.tenantId}/${digest}`;
}
