/**
 * H97 — the ADVERTISED run-duration ceiling must DERIVE from the ENFORCED one.
 *
 * `capabilities.limits.maxRunDurationMs` and `RUN_DURATION_CEILING_MS` used to be
 * two independent literals that happened to both read `600_000` — while BOTH
 * files carried a comment asserting they must agree, `executor.ts` going as far
 * as "advertise/enforce must agree". An invariant declared by comments and
 * enforced by nothing, on a WIRE-ADVERTISED limit: change the enforced ceiling
 * and the discovery document keeps promising the old number to every peer.
 *
 * MEASURED before the fix: `grep -rn maxRunDurationMs src/` returned ONE hit
 * (the literal), `discovery.ts` imported nothing from `executor.ts`, and
 * `grep -rln maxRunDurationMs test/` returned NOTHING — the advert had never
 * been asserted by any test at all.
 *
 * The derivation is the mechanism; these are the FLOOR. They exist for the one
 * failure derivation alone cannot catch: an import that silently resolves to
 * `undefined` compares equal to nothing and ships the field empty or absent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { RUN_DURATION_CEILING_MS, RUN_DISPATCH_LEASE_MS } from '../src/executor/executor.js';

describe('H97 — advertise/enforce agree by construction', () => {
  it('the enforced ceiling is a positive finite number (the undefined-import floor)', () => {
    // Deliberately NOT `toBe(600_000)`: pinning the value would make this test
    // fail on a legitimate change to the ceiling, which is how a floor becomes
    // noise and then gets deleted. What must never happen is the constant
    // arriving as undefined/NaN and the advert shipping empty.
    expect(typeof RUN_DURATION_CEILING_MS).toBe('number');
    expect(Number.isFinite(RUN_DURATION_CEILING_MS)).toBe(true);
    expect(RUN_DURATION_CEILING_MS).toBeGreaterThan(0);
  });

  it('the crashed-executor recovery SLO derives from the same constant', () => {
    // `RUN_DISPATCH_LEASE_MS` is what gates recovery of a run whose executor
    // died — the 12-minute stall an operator must know about. It rides the same
    // number, so a change to the ceiling moves a wire claim AND an operational
    // SLO. Pinned as a relationship, not a value.
    expect(RUN_DISPATCH_LEASE_MS).toBe(RUN_DURATION_CEILING_MS + 120_000);
  });

  it('discovery.ts advertises the CONSTANT, never a re-typed literal', () => {
    const src = readFileSync(new URL('../src/routes/discovery.ts', import.meta.url), 'utf8');
    const line = src.split('\n').find((l) => /^\s*maxRunDurationMs:/.test(l));
    expect(line, 'no `maxRunDurationMs:` advert found — this test would pass vacuously').toBeDefined();
    expect(line).toContain('RUN_DURATION_CEILING_MS');
    // The negative half: a bare number here is exactly the state H97 removed.
    expect(line).not.toMatch(/maxRunDurationMs:\s*[\d_]+/);
  });

  it('...and the matcher can actually fail (positive control)', () => {
    // Without this, a regex that matches nothing would make the leg above green
    // forever. Prove the check rejects the pre-H97 spelling.
    const pre = '      maxRunDurationMs: 600_000,';
    expect(pre).toMatch(/maxRunDurationMs:\s*[\d_]+/);
    expect(pre).not.toContain('RUN_DURATION_CEILING_MS');
  });
});
