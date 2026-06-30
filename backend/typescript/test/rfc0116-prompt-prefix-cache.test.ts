/**
 * RFC 0116 — prompt-prefix cache: the cross-tenant isolation core. The cached
 * Anthropic prefix is namespaced by (tenant, cachePrefixId) so tenant B's use of
 * tenant A's cachePrefixId produces DIFFERENT prefix bytes → Anthropic's
 * content-addressed cache structurally misses (B's first use → cacheReadTokens==0).
 * Same (tenant, cachePrefixId) → identical bytes → a real hit.
 */
import { describe, expect, it } from 'vitest';
import {
  cacheableAnthropicSystem,
  cachePrefixScopeMarker,
  type AnthropicSystemBlock,
} from '../src/providers/promptCaching.js';

const SYSTEM = 'You are a helpful assistant. '.repeat(50); // a stable, large-ish prefix
const text = (out: string | AnthropicSystemBlock[] | undefined): string =>
  Array.isArray(out) ? out.map((b) => b.text).join('') : (out ?? '');

describe('RFC 0116 — cross-tenant prefix isolation', () => {
  it('tenant B uses tenant A’s cachePrefixId → DIFFERENT prefix bytes (structural miss)', () => {
    const a = cacheableAnthropicSystem(SYSTEM, true, { tenant: 'tenant-A', cachePrefixId: 'X' });
    const b = cacheableAnthropicSystem(SYSTEM, true, { tenant: 'tenant-B', cachePrefixId: 'X' });
    expect(text(a)).not.toBe(text(b)); // different bytes → content-addressed cache misses
  });

  it('same (tenant, cachePrefixId) → IDENTICAL bytes (deterministic real hit + replay-safe)', () => {
    const a1 = cacheableAnthropicSystem(SYSTEM, true, { tenant: 'tenant-A', cachePrefixId: 'X' });
    const a2 = cacheableAnthropicSystem(SYSTEM, true, { tenant: 'tenant-A', cachePrefixId: 'X' });
    expect(text(a1)).toBe(text(a2));
  });

  it('a different cachePrefixId within the same tenant also differs', () => {
    const x = cacheableAnthropicSystem(SYSTEM, true, { tenant: 'tenant-A', cachePrefixId: 'X' });
    const y = cacheableAnthropicSystem(SYSTEM, true, { tenant: 'tenant-A', cachePrefixId: 'Y' });
    expect(text(x)).not.toBe(text(y));
  });

  it('BYOK: the scope marker is derived ONLY from tenant + cachePrefixId (no secret material)', () => {
    const marker = cachePrefixScopeMarker({ tenant: 'tenant-A', cachePrefixId: 'X' });
    expect(marker).toBe('[openwop-cache-scope tenant=tenant-A prefix=X]');
    // It contains exactly the two non-secret identifiers and nothing key-shaped.
    expect(marker).not.toMatch(/sk-|api[_-]?key|secret|bearer|token=/i);
  });

  it('the cached block still carries the ephemeral cache_control breakpoint', () => {
    const out = cacheableAnthropicSystem(SYSTEM, true, { tenant: 't', cachePrefixId: 'X' });
    expect(Array.isArray(out)).toBe(true);
    if (Array.isArray(out)) expect(out[out.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('backward-compat: no scope → single cached block (unchanged); caching off → plain string', () => {
    const noScope = cacheableAnthropicSystem(SYSTEM, true);
    expect(text(noScope)).toBe(SYSTEM); // marker absent
    expect(cacheableAnthropicSystem(SYSTEM, false)).toBe(SYSTEM); // plain, byte-identical
    expect(cacheableAnthropicSystem(undefined, true)).toBeUndefined();
  });
});
