import { describe, expect, it } from 'vitest';

import { providerIdempotencyKey } from '../src/host/providerIdempotencyKey.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import { resetLogicalInvocationOrdinals } from '../src/host/effectIdentity.js';

/**
 * `idempotency.md` §"Layer 2: effect identity", Provider-key rule — a MUST that
 * became binding when this host started advertising `idempotency`:
 *
 *   > When the provider accepts an idempotency key, the host MUST inject the
 *   > effect identity (or a documented deterministic derivative), stable across
 *   > retries.
 *
 * The behaviour being replaced was `randomUUID()` per call on the STRIPE path,
 * so these tests are about money movement before they are about conformance.
 */
function ctx(attempt: number) {
  return { runId: 'run-1', tenantId: 't1', nodeId: 'charge', attempt, replaying: false } as const;
}

describe('provider idempotency key is the effect identity', () => {
  it('is STABLE across node attempts — the retry counter is not in the identity', () => {
    resetLogicalInvocationOrdinals();
    const first = runWithEffectContext(ctx(1), () => providerIdempotencyKey({ operation: 'POST /v1/refunds' }));
    const retry = runWithEffectContext(ctx(2), () => providerIdempotencyKey({ operation: 'POST /v1/refunds' }));
    expect(first, 'a run effect must produce a key').toBeTruthy();
    expect(
      retry,
      'attempt 2 of the same logical effect presented a DIFFERENT key — this is the `randomUUID()` defect, and on the '
        + 'Stripe path it means a retried refund is not deduped',
    ).toBe(first);
  });

  it('two DIFFERENT operations in one node get DIFFERENT identities', () => {
    // `idempotency.md`: "Two distinct logical invocations MUST receive different
    // identities." Without this, a key stable across attempts would also collapse
    // a refund and a charge into one effect — stability alone is not correctness.
    // Reset between the two so BOTH calls take ordinal 0. Without that they
    // would differ because the ordinal advanced, and the test would pass without
    // the operation digest contributing anything — a green that proves nothing.
    resetLogicalInvocationOrdinals();
    const a = runWithEffectContext(ctx(1), () => providerIdempotencyKey({ operation: 'POST /v1/refunds' }));
    resetLogicalInvocationOrdinals();
    const b = runWithEffectContext(ctx(1), () => providerIdempotencyKey({ operation: 'POST /v1/charges' }));
    expect(a, 'same run/node/ordinal, different operation — the operation must reach the identity').not.toBe(b);

    // And the control: identical operation at the same position IS the same key.
    resetLogicalInvocationOrdinals();
    const again = runWithEffectContext(ctx(1), () => providerIdempotencyKey({ operation: 'POST /v1/refunds' }));
    expect(again).toBe(a);
  });

  it('matches the Idempotency-Key grammar', () => {
    resetLogicalInvocationOrdinals();
    const k = runWithEffectContext(ctx(1), () => providerIdempotencyKey({ operation: 'POST /v1/refunds' }));
    expect(k).toMatch(/^[A-Za-z0-9._~-]{22,128}$/);
  });

  it('returns undefined OUTSIDE a run — a fabricated key would be worse than none', () => {
    // Not a missing case: Layer 2's unit is the effect within a run. A route or
    // daemon calling a provider directly has no effect to key on, and inventing a
    // stable-looking key would claim an identity the host cannot reproduce.
    expect(providerIdempotencyKey({ operation: 'POST /v1/refunds' })).toBeUndefined();
  });

  it('returns undefined when the context lacks the recipe’s inputs', () => {
    // The activity recipe needs tenant + node + attempt. A partial context must
    // fail closed to `undefined` rather than hash `undefined` into a key that
    // looks legitimate.
    const partial = { runId: 'run-1', replaying: false } as const;
    expect(runWithEffectContext(partial, () => providerIdempotencyKey({ operation: 'POST /v1/refunds' }))).toBeUndefined();
  });
});
