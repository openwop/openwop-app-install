/**
 * RFC 0116 — end-to-end prompt-prefix cache witness. Uses the REAL prefix
 * assembly (`cacheableAnthropicSystem` with the (tenant, cachePrefixId) scope)
 * against a CONTENT-ADDRESSED mock cache — the same model as Anthropic's
 * ephemeral cache, which keys on the literal prefix bytes. Proves the protocol
 * MUSTs without a live Anthropic key:
 *  - a HIT reports cacheReadTokens > 0;
 *  - a cross-tenant MISS (tenant B reusing tenant A's cachePrefixId) reports
 *    cacheReadTokens == 0 — a STRUCTURAL miss (different bytes), not bookkeeping;
 *  - outcome-invariance: inputTokens/outputTokens are identical hit vs miss.
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
  it('prime → hit → cross-tenant miss, with outcome-invariance', () => {
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

    // Outcome-invariance: a hit and a miss bill identical input/output tokens —
    // cachePrefixId is a COST hint only, never a semantic input.
    expect(a2.inputTokens).toBe(b1.inputTokens);
    expect(a2.outputTokens).toBe(b1.outputTokens);
  });

  it('no scope (global) would FALSELY share across tenants — the bug this prevents', () => {
    const anthropic = makeContentAddressedAnthropic();
    // Without the (tenant, cachePrefixId) scope, both tenants assemble identical
    // bytes → tenant B would HIT tenant A's cache (the cross-tenant leak). This
    // asserts the hazard exists absent namespacing, so the fix is load-bearing.
    anthropic.call(cacheableAnthropicSystem(SYSTEM, true)); // "A" primes (unscoped)
    const bUnscoped = anthropic.call(cacheableAnthropicSystem(SYSTEM, true)); // "B" — same bytes
    expect(bUnscoped.cacheReadTokens).toBeGreaterThan(0); // leak WITHOUT scope → why we scope
  });
});
