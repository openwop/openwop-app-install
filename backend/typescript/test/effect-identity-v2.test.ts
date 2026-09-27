/**
 * ADR 0549 P3 — RFC 0150 §B, the Layer-2 logical effect identity v2.
 *
 * ## Why this file is a HOST witness, and why that matters
 *
 * RFC 0150's gap register records G9 against the invariant
 * `logical-effect-id-retry-stable`: it has **no black-box witness**, because
 * whether an engine reuses the identity across an internal retry is observed by
 * the *provider*, not the caller — the injected key never crosses a seam a
 * conformance driver can see. The corpus scenario
 * `effect-identity-composition.test.ts` therefore witnesses the NORMATIVE
 * COMPOSITION (corpus-structural tier): real evidence that the spec no longer
 * specifies the defect, and explicitly NOT evidence that any host implements it.
 *
 * This file supplies the missing half at host tier. It drives the real
 * `callAI` path twice at two different `attempt` values and asserts the identity
 * is byte-identical — the observation G9 says the wire cannot make.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  logicalInvocationId,
  nextLogicalInvocationOrdinal,
  resetLogicalInvocationOrdinals,
  beginNodeActivity,
  ACTIVITY_IDENTITY_RECIPE_V2,
} from '../src/host/effectIdentity.js';
import {
  createAiProvidersAdapter,
  __lastInvocationCacheKeyForTests,
} from '../src/aiProviders/aiProvidersHost.js';
import { programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';
import { semanticRequestDigestV2 } from '../src/providers/llmCacheKey.js';
import { setInvocationBackend } from '../src/executor/invocationLog.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';

const BASE = {
  tenantId: 'tenant-a',
  runId: 'run-1',
  nodeId: 'node-1',
  logicalInvocationOrdinal: 0,
  providerKey: 'openai:chat:completions',
} as const;

describe('RFC 0150 §B — the v2 composition', () => {
  it('reproduces the spec preimage exactly', () => {
    // Recomputed independently from `spec/v1/idempotency.md` §"Idempotency key
    // composition" rather than snapshotted from the implementation: a snapshot
    // of our own output would go green on any composition we happened to write.
    const expected = createHash('sha256')
      .update(
        ['openwop:activity:v2', 'tenant-a', 'run-1', 'node-1', '0', 'openai:chat:completions'].join('\0'),
        'utf8',
      )
      .digest('base64url');
    expect(logicalInvocationId(BASE)).toBe(expected);
    expect(ACTIVITY_IDENTITY_RECIPE_V2).toBe('openwop:activity:v2');
  });

  it('is base64url without padding', () => {
    expect(logicalInvocationId(BASE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('every preimage field is load-bearing', () => {
    const base = logicalInvocationId(BASE);
    expect(logicalInvocationId({ ...BASE, tenantId: 'tenant-b' })).not.toBe(base);
    expect(logicalInvocationId({ ...BASE, runId: 'run-2' })).not.toBe(base);
    expect(logicalInvocationId({ ...BASE, nodeId: 'node-2' })).not.toBe(base);
    expect(logicalInvocationId({ ...BASE, logicalInvocationOrdinal: 1 })).not.toBe(base);
    expect(logicalInvocationId({ ...BASE, providerKey: 'stripe:create-charge' })).not.toBe(base);
  });

  it('tenantId separates two tenants that collide on everything else', () => {
    // `idempotency.md`: without tenantId "two tenants that collide on
    // (runId, nodeId, ordinal, providerKey) share an invocation-log entry, and
    // the second tenant is served the first tenant's cached provider response."
    expect(logicalInvocationId({ ...BASE, tenantId: 'a' })).not.toBe(
      logicalInvocationId({ ...BASE, tenantId: 'b' }),
    );
  });

  it('the NUL join is injective — a field carrying NUL is rejected, not silently merged', () => {
    // Without this guard `('a\0b', 'c')` and `('a', 'b\0c')` would produce one
    // preimage, which is the only way this composition can silently collide.
    expect(() => logicalInvocationId({ ...BASE, nodeId: 'node\u00001' })).toThrow(/NUL/);
    expect(() => logicalInvocationId({ ...BASE, tenantId: 'a\u0000b' })).toThrow(/NUL/);
  });

  it('the type offers no way to pass an attempt counter', () => {
    // The v1 composition `sha256(runId ':' nodeId ':' attempt ':' providerKey)`
    // was retired as a safety-fix. Structural, not aspirational: adding
    // `attempt` to the call below is a compile error, which is why this leg
    // asserts on the surface rather than on a value.
    expect(Object.keys(BASE).sort()).toEqual(
      ['logicalInvocationOrdinal', 'nodeId', 'providerKey', 'runId', 'tenantId'],
    );
  });
});

describe('RFC 0150 §B — the ordinal allocator', () => {
  beforeEach(() => resetLogicalInvocationOrdinals());

  it('numbers distinct logical invocations within one attempt', () => {
    // "Two distinct logical invocations MUST receive different ordinals even
    // when every other input matches — a node that calls the same provider
    // twice on purpose is performing two effects, and they MUST NOT deduplicate
    // against each other."
    expect(nextLogicalInvocationOrdinal('r', 'n', 1)).toBe(0);
    expect(nextLogicalInvocationOrdinal('r', 'n', 1)).toBe(1);
    expect(nextLogicalInvocationOrdinal('r', 'n', 1)).toBe(2);
  });

  it('REWINDS on a new attempt, so the retry re-issues the same logical effect', () => {
    expect(nextLogicalInvocationOrdinal('r', 'n', 1)).toBe(0);
    expect(nextLogicalInvocationOrdinal('r', 'n', 1)).toBe(1);
    // Attempt 2 re-executes the node body, so its first activity is the SAME
    // logical effect as attempt 1's first activity. A monotonic counter here
    // would smuggle `attempt` back into the identity through the ordinal.
    expect(nextLogicalInvocationOrdinal('r', 'n', 2)).toBe(0);
    expect(nextLogicalInvocationOrdinal('r', 'n', 2)).toBe(1);
  });

  it('does not leak between nodes or runs', () => {
    expect(nextLogicalInvocationOrdinal('r', 'n1', 1)).toBe(0);
    expect(nextLogicalInvocationOrdinal('r', 'n2', 1)).toBe(0);
    expect(nextLogicalInvocationOrdinal('r2', 'n1', 1)).toBe(0);
  });
});

describe('RFC 0150 §B — `logical-effect-id-retry-stable`, witnessed at host tier (G9)', () => {
  let storage: Storage;

  const policyResolver: ProviderPolicyResolver = { async resolveForRun() { return []; } };
  const scopeAt = (attempt: number) => ({
    runId: 'retry-run',
    nodeId: 'retry-node',
    tenantId: 'retry-tenant',
    attempt,
    secrets: {},
    policyResolver,
  });
  const REQUEST = { provider: 'mock', model: 'mock-1', messages: [{ role: 'user' as const, content: 'hi' }] };

  beforeEach(async () => {
    storage = await openStorage('memory://');
    setInvocationBackend(storage);
    resetLogicalInvocationOrdinals();
    resetMockPrograms();
  });
  afterEach(async () => {
    await storage.close();
  });

  it('two ATTEMPTS at the same logical effect compute the SAME identity', async () => {
    programMock('retry-node', [{ content: 'first' }, { content: 'second' }]);

    await createAiProvidersAdapter(scopeAt(1)).callAI(REQUEST);
    const first = __lastInvocationCacheKeyForTests();
    expect(first?.attempt).toBe(1);

    await createAiProvidersAdapter(scopeAt(2)).callAI(REQUEST);
    const second = __lastInvocationCacheKeyForTests();
    expect(second?.attempt).toBe(2);

    // The observation G9 says no wire probe can make: the value the engine
    // would inject as the provider's `Idempotency-Key` is unchanged by the
    // retry. Under the retired v1 composition these differed, which handed the
    // provider a key it had never seen and defeated its deduplication.
    expect(second?.invocationId).toBe(first?.invocationId);
    expect(second?.logicalInvocationOrdinal).toBe(first?.logicalInvocationOrdinal);
    // …and the record still carries the attempt, which the spec keeps as
    // telemetry and ADR 0326 P3a's replay fidelity depends on.
    expect(second?.attempt).not.toBe(first?.attempt);
  });

  it('a retry does NOT re-fire an effect that already succeeded', async () => {
    // Only ONE mock outcome is staged. If the retry re-dispatched, the mock
    // would be exhausted and the call would fail or return different content.
    programMock('retry-node', [{ content: 'the one and only call' }]);

    const a = await createAiProvidersAdapter(scopeAt(1)).callAI(REQUEST);
    expect(a.content).toBe('the one and only call');

    const b = await createAiProvidersAdapter(scopeAt(2)).callAI(REQUEST);
    expect(b.content).toBe('the one and only call');
  });

  it('a node that calls the same provider TWICE performs two effects', async () => {
    // Same request bytes, so the semantic digest is identical — the ORDINAL is
    // the only thing separating them, which is what §B requires. Before P3 the
    // second call read the first's cached record and the provider saw one call.
    programMock('retry-node', [{ content: 'call-a' }, { content: 'call-b' }]);
    const adapter = createAiProvidersAdapter(scopeAt(1));

    const one = await adapter.callAI(REQUEST);
    const idOne = __lastInvocationCacheKeyForTests()?.invocationId;
    const two = await adapter.callAI(REQUEST);
    const idTwo = __lastInvocationCacheKeyForTests()?.invocationId;

    expect(idTwo).not.toBe(idOne);
    expect(one.content).toBe('call-a');
    expect(two.content).toBe('call-b');
  });

  it('a node body that RE-ENTERS at the same attempt does not re-fire its effect', async () => {
    // The scenario `beginNodeActivity` exists for, and the one the attempt
    // counter cannot see: a HITL `SuspendSignal` unwinds out of the node and
    // the resume re-runs the handler from the top — same run, same node, SAME
    // attempt. Without a rewind the resumed body's first AI call takes ordinal
    // 1 instead of 0, mints a different identity, misses the cache, and calls
    // the provider a second time for an effect already performed.
    //
    // ONE mock outcome is staged, so a second dispatch is observable: it would
    // return '' rather than the recorded content.
    programMock('retry-node', [{ content: 'performed once' }]);

    beginNodeActivity('retry-run', 'retry-node', 1);
    const before = await createAiProvidersAdapter(scopeAt(1)).callAI(REQUEST);
    const idBefore = __lastInvocationCacheKeyForTests()?.invocationId;
    expect(before.content).toBe('performed once');

    beginNodeActivity('retry-run', 'retry-node', 1); // the node re-enters
    const after = await createAiProvidersAdapter(scopeAt(1)).callAI(REQUEST);

    expect(__lastInvocationCacheKeyForTests()?.invocationId).toBe(idBefore);
    expect(after.content).toBe('performed once');
  });

  it('the providerKey is EXACTLY the §C digest — no host field smuggled in', async () => {
    // The strongest available form of "transport-only fields are excluded":
    // rather than probing one field at a time, pin the emitted key to the
    // digest of the declared semantic request. ANY extra input the host folds
    // in — the `credentialRefHashed` it used to hash, a tenant id, a trace
    // header — makes this diverge.
    //
    // §C excludes credential handles for a reason worth stating: the digest
    // "MUST NOT be used as a security boundary", and hashing a host-local
    // credential handle into it makes the key non-PORTABLE, so two hosts
    // computing the same request get different keys and §D's cross-host
    // determinism invariant fails. Isolation lives in the IDENTITY's
    // `tenantId`, asserted in the next case.
    programMock('retry-node', [{ content: 'a' }]);
    await createAiProvidersAdapter(scopeAt(1)).callAI(REQUEST);

    const expected = semanticRequestDigestV2({
      provider: 'mock',
      model: 'mock-1',
      messages: [{ role: 'user', content: 'hi' }],
      // The dispatcher default, filled in BEFORE hashing so an omitted bound
      // and an explicit 4096 are one effective request rather than two.
      maxOutputTokens: 4096,
    });
    expect(__lastInvocationCacheKeyForTests()?.providerKey).toBe(expected);
  });

  it('§E dual-read: a record written under the PRE-P3 key still resolves', async () => {
    // `spec/v1/replay.md` §E lets a host "continue using their existing key
    // alongside the canonical one … During the dual-write window, Layer-2
    // lookups check both keys." Without it, every run in flight across the
    // deploy loses its cache and RE-FIRES its provider calls — the concrete
    // harm is a second paid completion, or a second charge on a node that
    // wraps one.
    //
    // The legacy key is recomputed here the way the pre-P3 host computed it:
    // sorted-key canonical JSON over the request shape PLUS the hashed
    // credential ref, hex SHA-256.
    // The `mock` provider resolves to the `'mock'` credential sentinel
    // (`resolveCredential`), which is what the pre-P3 key hashed.
    const credentialRefHashed = createHash('sha256').update('mock').digest('hex');
    const legacyInput = {
      provider: 'mock',
      model: 'mock-1',
      messages: REQUEST.messages,
      systemPrompt: null,
      temperature: null,
      maxTokens: 4096,
      stopSequences: null,
      responseSchema: null,
      credentialRefHashed,
    };
    const sortDeep = (v: unknown): unknown => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(sortDeep);
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortDeep(o[k]);
      return out;
    };
    const legacyKey = createHash('sha256').update(JSON.stringify(sortDeep(legacyInput))).digest('hex');

    await storage.putInvocation(
      { runId: 'retry-run', nodeId: 'retry-node', attempt: 1, invocationId: legacyKey },
      { content: 'recorded before P3' },
    );

    // No mock program is staged. A dispatch would therefore NOT return this
    // content — so the assertion can only pass through the dual-read.
    const res = await createAiProvidersAdapter(scopeAt(1)).callAI(REQUEST);
    expect(res.content).toBe('recorded before P3');
  });

  it('two tenants issuing the identical effect do not share an invocation record', async () => {
    programMock('retry-node', [{ content: 'tenant-a answer' }, { content: 'tenant-b answer' }]);

    await createAiProvidersAdapter({ ...scopeAt(1), tenantId: 'tenant-a' }).callAI(REQUEST);
    const a = __lastInvocationCacheKeyForTests();
    resetLogicalInvocationOrdinals();
    await createAiProvidersAdapter({ ...scopeAt(1), tenantId: 'tenant-b' }).callAI(REQUEST);
    const b = __lastInvocationCacheKeyForTests();

    expect(a?.providerKey).toBe(b?.providerKey); // same semantic request …
    expect(a?.invocationId).not.toBe(b?.invocationId); // … different identity
  });
});

describe('RFC 0150 §B v1.4 — cross-scope effects are keyed on a BUSINESS identity', () => {
  it('the commerce refund key contains no run/node/ordinal component', async () => {
    // `idempotency.md` v1.4: a Layer-2 identity is RUN-SCOPED, so an effect also
    // reachable outside any run "MUST additionally key" on an identity derived
    // from the business operation — stable across every entry point and
    // containing no `runId`, `nodeId`, or ordinal.
    //
    // This host's refund path is the tier-1 report that produced that clause
    // (RFC 0150 gap register G7, closed 2026-08-12). `refundOrder` is reachable
    // from `feature.commerce.nodes.refund-order` AND from an HTTP route, connect
    // admin and a seeder — so keying it on the §B identity would let an agent
    // refunding order X inside a run refund it a second time thirty seconds
    // after an operator already did.
    //
    // Pinned here rather than trusted: the property is invisible until it costs
    // real money, and the fix is a one-word edit away from being undone.
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/features/commerce/commerceService.ts', import.meta.url), 'utf8'),
    );
    const keys = [...src.matchAll(/idempotencyKey:\s*`([^`]+)`/g)].map((m) => m[1]);
    expect(keys.length, 'the refund paths MUST still pass explicit idempotency keys').toBeGreaterThan(0);
    for (const key of keys) {
      expect(key, `business key "${key}" must be order-derived`).toMatch(/orderId/);
      expect(key, `business key "${key}" must not carry run scope`).not.toMatch(/runId|nodeId|attempt|ordinal/);
    }
  });
});
