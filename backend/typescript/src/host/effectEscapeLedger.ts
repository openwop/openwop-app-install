/**
 * ADR 0591 P2 — the durable per-identity effect escape record.
 *
 * WHY THIS IS NOT A CALL INSIDE `assertEffectAllowed`, which is where the four
 * other consumers of the allow branch live and where P1 planned to put it.
 * Two independent reasons, both measured rather than argued:
 *
 *   1. THE GUARD IS SYNCHRONOUS BY CONTRACT, and a durable write is not. Two of
 *      its call sites are undici dispatcher getters — `webhookEgressDispatcher():
 *      Agent` (webhookEgressGuard.ts) and `safeFetchDispatcher(): Agent`
 *      (connectionInjection.ts) — whose return value is passed as undici's
 *      `dispatcher:` option at ~20 sites. That option takes a Dispatcher, not a
 *      Promise. `test/egress-pin.test.ts` identity-compares the returned Agent
 *      and `test/run-effect-context.test.ts:371` asserts a SYNCHRONOUS throw.
 *      Making the guard async breaks all of it.
 *
 *      Fire-and-forget from the sync guard is the other way out and it is worse.
 *      The row would be lost exactly when the process dies between the effect
 *      and the flush — which is not a random window, it is the one RFC 0158
 *      §C.7 manufactures on purpose. This host has already shipped that bug once
 *      (CLAUDE.md: a detached SPA-shell refresh Cloud Run's `cpu-throttling`
 *      never resumed, 16+ minutes stale with ZERO error logs — so the `.catch`
 *      is not a safety net, it is the thing that does not fire).
 *
 *   2. THE GUARD SEAM IS NOT AN ESCAPE-EVENT SEAM AT ALL OF ITS SITES. Most are
 *      "about to do the deed" (stripe, smtp, notification, sub-run dispatch),
 *      but the two dispatcher getters are "hand out a capability that will
 *      later do the deed" — the guard fires when an `Agent` is OBTAINED and the
 *      packet leaves later, from a cached singleton, through a fetch the guard
 *      never sees. For `recordEffectAllowed` (a host-wide rate where any
 *      non-zero value is actionable) that conflation is tolerable noise. For an
 *      instrument that must distinguish COUNT 1 from COUNT 2 at one identity it
 *      is not.
 *
 * So coverage here is PER-SEAM AND EXPLICIT rather than universal-by-adjacency.
 * That is a real limitation and it is stated rather than implied: a ledger
 * honest about which seams it observes beats one whose placement implies it
 * observes all of them. The seams that call this are listed in the ADR; the
 * guard remains the authority on whether an effect may proceed, and this
 * records that it did.
 *
 * ORDERING: the append is awaited BEFORE the effect fires, which inverts the
 * error direction from the floor P1 assumed to a CEILING. Under-reporting is
 * now structurally impossible — a genuine double-fire can never read as 1 —
 * and over-reporting is possible in the crash-between-append-and-fire window.
 * That is the correct direction for a witness: the failure mode is a loud false
 * FAIL, never a silent false PASS. The consequence for readers is that
 * `count >= 2` is no longer automatically a real double-fire.
 */

import { logicalInvocationId, nextLogicalInvocationOrdinal } from './effectIdentity.js';
import { currentEffectContext } from './runEffectContext.js';
import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';

const log = createLogger('effect.escapeLedger');

let backend: Storage | null = null;

export function setEffectEscapeBackend(storage: Storage): void {
  backend = storage;
}

/** Test seam — drop the installed backend so a suite can assert the no-op path. */
export function __resetEffectEscapeBackendForTest(): void {
  backend = null;
}

/** One logical effect's RFC 0150 §B identity, plus the fields a seam needs to
 *  address the invocation log with it. */
export interface EffectIdentity {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly invocationId: string;
  readonly providerKey: string;
}

/**
 * Allocate the identity for the logical effect this seam is ABOUT to perform.
 *
 * MINTING IS SEPARATE FROM APPENDING, and the split is not cosmetic. The
 * ordinal is ALLOCATED, not derived — `nextLogicalInvocationOrdinal` increments
 * a counter — so calling it twice for one logical effect yields two different
 * identities. A seam that wants to dedupe must therefore mint ONCE and reuse
 * that identity for the invocation-log lookup, the ledger row, and the memo
 * write. Folding the mint into the append (the shape this file shipped with in
 * P2) makes a deduping seam structurally impossible: the lookup and the row
 * would name different effects.
 *
 * Returns `null` when there is no logical identity to compute:
 *   - no ambient node execution — an effect from an HTTP route or a daemon
 *     sweep belongs to no run. Same rule the ADR 0533 per-run counter follows;
 *     not a failure.
 *   - inside a run but missing the identity inputs — that IS a failure (the
 *     executor stopped populating them), so it logs rather than passing
 *     quietly. A guard that cannot identify its subject must say so.
 */
export function mintEffectIdentity(providerKey: string): EffectIdentity | null {
  const ctx = currentEffectContext();
  if (!ctx) return null;
  if (!ctx.nodeId || !ctx.tenantId) {
    log.error('ADR 0591: effect inside a run with no identity inputs — the ledger is silently under-recording', {
      runId: ctx.runId,
      providerKey,
      hasNodeId: Boolean(ctx.nodeId),
      hasTenantId: Boolean(ctx.tenantId),
    });
    return null;
  }
  const attempt = ctx.attempt ?? 1;
  // The ONE owner computes the identity. This module never composes a preimage.
  const logicalInvocationOrdinal = nextLogicalInvocationOrdinal(ctx.runId, ctx.nodeId, attempt);
  return {
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    attempt,
    providerKey,
    invocationId: logicalInvocationId({
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      nodeId: ctx.nodeId,
      logicalInvocationOrdinal,
      providerKey,
    }),
  };
}

/**
 * Record that the effect at this ALREADY-MINTED identity is about to escape.
 *
 * Call this only AFTER the dedup/fence decision has come back "proceed". A row
 * written before that decision describes an effect that may then be correctly
 * suppressed, which turns a conformant host into a failing one — see the
 * ordering note in this file's header.
 */
export async function recordDurableEffectEscapeAt(identity: EffectIdentity): Promise<void> {
  if (!backend) return;
  await backend.appendEffectEscape({
    runId: identity.runId,
    nodeId: identity.nodeId,
    invocationId: identity.invocationId,
    effectKind: identity.providerKey,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Mint-and-append in one call, for seams that have NO dedup layer to consult.
 *
 * `providerKey` is the effect's own stable name — `effectIdentity.ts` names
 * `'stripe:create-charge'` and `'send-email'` as the shape. It MUST be stable
 * across a kill/resume of the same logical effect, or the pre- and post-kill
 * rows carry different identities and both counts read 1, which would make the
 * witness pass vacuously on exactly the defect it exists to catch.
 */
export async function recordDurableEffectEscape(providerKey: string): Promise<void> {
  const identity = mintEffectIdentity(providerKey);
  if (!identity) return;
  await recordDurableEffectEscapeAt(identity);
}
