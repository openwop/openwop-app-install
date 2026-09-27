import { createHash } from 'node:crypto';

import { logicalInvocationId, nextLogicalInvocationOrdinal } from './effectIdentity.js';
import { currentEffectContext } from './runEffectContext.js';

/**
 * The idempotency key to present to an outbound provider that accepts one.
 *
 * `spec/v2/core/idempotency.md` §"Layer 2: effect identity", the Provider-key
 * rule, is a MUST bound by advertising `idempotency` — which this host now does:
 *
 *   > When the provider accepts an idempotency key, the host MUST inject the
 *   > effect identity (or a documented deterministic derivative), stable across
 *   > retries.
 *
 * WHAT THIS REPLACES, because the old behaviour is the reason this exists.
 * `features/billing/stripeApi.ts` sent `idempotency-key: idempotencyKey ??
 * randomUUID()`. A fresh UUID per call is neither the effect identity nor stable
 * across retries: a node re-attempt or a fork issues a NEW key, so Stripe cannot
 * dedupe it — on the money-movement path. The in-file comment said as much
 * ("minted per CALL … cannot dedupe a replay"), which was an honest note about a
 * gap while the family was unadvertised, and a violated MUST the moment it was.
 *
 * WHY THE ACTIVITY RECIPE AND NOT A BUSINESS KEY. `idempotency.md:32` names two
 * keyings and this host declares the second on its own ledger projection:
 * business-identity is preferred, and "the activity recipe (`keying:
 * activity-recipe`: tenant, run, node, ordinal, `providerKey`) is the fallback
 * for a provider with no business key". `logicalInvocationId` IS that recipe,
 * exactly, and it is attempt-free by construction — `attempt` never enters its
 * preimage — which is what satisfies "the retry counter MUST NOT participate in
 * the identity".
 *
 * OUTSIDE A RUN THERE IS NO EFFECT TO KEY ON. Routes and daemons calling a
 * provider directly are not run effects; Layer 2's unit is the effect within a
 * run, and Layer 1 already covers the inbound request. Those callers get
 * `undefined` and keep whatever behaviour they had. Returning a *fabricated*
 * stable key there would be worse than none: it would claim an identity the host
 * cannot reproduce on a retry it never records.
 */
export function providerIdempotencyKey(operationDigestInput: {
  /** Names the business operation — e.g. `POST /v1/refunds` plus its form. */
  readonly operation: string;
}): string | undefined {
  const ctx = currentEffectContext();
  // No ambient run: not a run effect. See the docblock — this is a deliberate
  // `undefined`, not a missing case.
  if (!ctx || !ctx.tenantId || !ctx.nodeId || typeof ctx.attempt !== 'number') return undefined;

  // The recipe's `providerKey` slot. For an LLM call this is the semantic
  // request digest; for a REST provider the analogue is a digest of the business
  // operation being performed, which is what makes two DIFFERENT operations in
  // one node resolve to different identities ("Two distinct logical invocations
  // MUST receive different identities").
  const providerKey = createHash('sha256').update(operationDigestInput.operation, 'utf8').digest('base64url');

  const ordinal = nextLogicalInvocationOrdinal(ctx.runId, ctx.nodeId, ctx.attempt);
  return logicalInvocationId({
    tenantId: ctx.tenantId,
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    logicalInvocationOrdinal: ordinal,
    providerKey,
  });
}
