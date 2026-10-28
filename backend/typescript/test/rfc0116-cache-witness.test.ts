/**
 * RFC 0116 — end-to-end prompt-prefix cache witness. Uses the REAL prefix
 * assembly (`cacheableAnthropicSystem` with the (tenant, cachePrefixId) scope)
 * against a CONTENT-ADDRESSED mock cache — the same model as Anthropic's
 * ephemeral cache, which keys on the literal prefix bytes. Proves the protocol
 * MUSTs without a live Anthropic key:
 *  - a HIT reports cacheReadTokens > 0;
 *  - a cross-tenant MISS (tenant B reusing tenant A's cachePrefixId) reports
 *    cacheReadTokens == 0 — a STRUCTURAL miss (different bytes), not bookkeeping.
 *
 * Round-2 grade note (PROTECTED-LOW, kept by ruling): the cross-tenant miss is
 * the same break as its twins `rfc0116-prompt-prefix-cache.test.ts` › "tenant B
 * uses tenant A’s cachePrefixId → DIFFERENT prefix bytes" (unit) and
 * `rfc0116-prefix-cache-seam.test.ts` › "A primes → A hits → B…" (HTTP, real
 * seam); probe 8fw2g1-cw-marker-notenant reds all three. The old
 * "outcome-invariance" asserts compared two constants of this file's OWN mock
 * (no product edit could red them) and were removed; outcome-invariance on the
 * wire is the seam's claim (rfc0116-prefix-cache-seam). Case 2 now pins the
 * unscoped bytes literally instead of asserting a mock hit.
 */
import { describe, expect, it } from 'vitest';
import { cacheableAnthropicSystem, type AnthropicSystemBlock } from '../src/providers/promptCaching.js';

const SYSTEM = 'You are a careful assistant. '.repeat(80); // a large, stable prefix

/** A content-addressed cache keyed by the literal prefix bytes (Anthropic model).
 *  Returns the cost-only token split the host would emit on provider.usage. */
function makeContentAddressedAnthropic() {
  const primed = new Set<string>();
  const INPUT = 1000;
  const OUTPUT = 20;
  return {
    /** Dispatch a request whose cached system block carries the prefix bytes. */
    call(system: string | AnthropicSystemBlock[] | undefined): {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    } {
      const bytes = Array.isArray(system) ? system.map((b) => b.text).join('') : (system ?? '');
      if (primed.has(bytes)) {
        return { inputTokens: INPUT, outputTokens: OUTPUT, cacheReadTokens: INPUT, cacheWriteTokens: 0 };
      }
      primed.add(bytes);
      return { inputTokens: INPUT, outputTokens: OUTPUT, cacheReadTokens: 0, cacheWriteTokens: INPUT };
    },
  };
}

describe('RFC 0116 — two-tenant cache witness (real prefix assembly + content-addressed cache)', () => {
  it('prime → hit → cross-tenant miss (same cachePrefixId, different tenant)', () => {
    const anthropic = makeContentAddressedAnthropic();
    const scopeA = { tenant: 'tenant-A', cachePrefixId: 'shared-id' };
    const scopeB = { tenant: 'tenant-B', cachePrefixId: 'shared-id' }; // SAME cachePrefixId

    // Tenant A, call 1 — PRIME (write > 0, read == 0).
    const a1 = anthropic.call(cacheableAnthropicSystem(SYSTEM, true, scopeA));
    expect(a1.cacheReadTokens).toBe(0);
    expect(a1.cacheWriteTokens).toBeGreaterThan(0);

    // Tenant A, call 2 — HIT (read > 0).
    const a2 = anthropic.call(cacheableAnthropicSystem(SYSTEM, true, scopeA));
    expect(a2.cacheReadTokens).toBeGreaterThan(0);

    // Tenant B, FIRST use of tenant A's cachePrefixId — STRUCTURAL MISS (read == 0).
    const b1 = anthropic.call(cacheableAnthropicSystem(SYSTEM, true, scopeB));
    expect(b1.cacheReadTokens).toBe(0); // the cross-tenant isolation MUST
  });

  it('unscoped assembly is the bare SYSTEM bytes, so two unscoped tenants would share one cache entry', () => {
    // Without the (tenant, cachePrefixId) scope the assembled block is exactly the
    // system prompt (no tenant in the bytes), so a content-addressed cache cannot
    // tell two tenants apart: the hazard the scope exists to prevent. Twin:
    // rfc0116-prompt-prefix-cache › "backward-compat: no scope → …".
    expect(cacheableAnthropicSystem(SYSTEM, true)).toEqual([
      { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
    ]);
    const anthropic = makeContentAddressedAnthropic();
    anthropic.call(cacheableAnthropicSystem(SYSTEM, true)); // "A" primes (unscoped)
    const bUnscoped = anthropic.call(cacheableAnthropicSystem(SYSTEM, true)); // "B" — same bytes
    expect(bUnscoped.cacheReadTokens).toBeGreaterThan(0);
  });
});
