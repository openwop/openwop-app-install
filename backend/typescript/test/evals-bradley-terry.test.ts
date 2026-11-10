/**
 * ADR 0986 D5 — Bradley–Terry standings (`features/evals/bradleyTerry.ts`).
 *
 * The properties the arena relies on: the fit depends only on the multiset of
 * outcomes (never on the order verdicts were cast, unlike the retired running
 * Elo), a tie is symmetric, an unbeaten model stays finite, a disconnected graph
 * still fits, and more wins means a higher rating.
 *
 * The ratings pinned below are hand-derived, not computed by the subject. With
 * one model on w wins and the other on none, strengths are reciprocal (p, 1/p) and
 * the fixed point solves (w + 1/2) = p/(p+1) + w·p²/(p²+1). w = 6 gives p = 4.279877,
 * so 1500 ± 400·log10(p) = 1752.573 / 1247.427. w = 1 gives p = 2.130395
 * (p³ − p² − p − 3 = 0), so 1631.384 / 1368.616.
 *
 * Sabotage witnesses (w77): scoring a tie as a win for A reds "a tie…"; zeroing the
 * virtual half-win or the virtual game (each half of the virtual tie is one edit)
 * reds "unbeaten…"; a different Elo scale or reference reds the pinned ratings;
 * dropping an outcome reds the order case. Two sabotages cannot fail by design: the
 * fit is Jacobi (each round reads the previous round's strengths), so unsorting the
 * models changes nothing, and with no outcomes the fit is an empty map with or
 * without its early return.
 */
import { describe, it, expect } from 'vitest';
import { bradleyTerry, type PairOutcome } from '../src/features/evals/bradleyTerry.js';

const o = (a: string, b: string, scoreA: number): PairOutcome => ({ a, b, scoreA });

describe('bradleyTerry', () => {
  it('is empty for no outcomes', () => {
    expect(bradleyTerry([]).size).toBe(0);
  });

  it('a tie is symmetric and leaves both at the reference', () => {
    const r = bradleyTerry([o('x', 'y', 0.5)]);
    expect(r.get('x')).toBeCloseTo(1500, 6);
    expect(r.get('y')).toBeCloseTo(1500, 6);
  });

  it('an unbeaten model stays finite and above its victim', () => {
    const r = bradleyTerry(Array.from({ length: 6 }, () => o('champ', 'chump', 1)));
    expect(Number.isFinite(r.get('champ'))).toBe(true);
    // Finite because the virtual tie bounds it, not because the iteration cap
    // stopped it short: an exact value, and the two sit symmetrically about 1500.
    expect(r.get('champ')).toBeCloseTo(1752.573, 2);
    expect(r.get('chump')).toBeCloseTo(1247.427, 2);
    const single = bradleyTerry([o('a', 'b', 1)]);
    expect(single.get('a')).toBeCloseTo(1631.384, 2);
    expect(single.get('b')).toBeCloseTo(1368.616, 2);
  });

  it('does not depend on the order outcomes arrive in', () => {
    const outcomes = [o('a', 'b', 1), o('b', 'c', 1), o('a', 'c', 0.5), o('c', 'a', 0), o('b', 'a', 1), o('d', 'a', 0)];
    const forward = bradleyTerry(outcomes);
    const reversed = bradleyTerry([...outcomes].reverse());
    expect(forward.size).toBe(4);
    for (const [k, v] of forward) expect(reversed.get(k)).toBeCloseTo(v, 9);
  });

  it('fits a disconnected comparison graph through the reference', () => {
    const r = bradleyTerry([o('a', 'b', 1), o('c', 'd', 1)]);
    expect(r.get('a')).toBeCloseTo(r.get('c')!, 9);
    expect(r.get('b')).toBeCloseTo(r.get('d')!, 9);
  });

  it('more wins against the same field means a higher rating', () => {
    const r = bradleyTerry([o('strong', 'mid', 1), o('strong', 'mid', 1), o('strong', 'mid', 0), o('weak', 'mid', 0), o('weak', 'mid', 0), o('weak', 'mid', 1)]);
    expect(r.get('strong')!).toBeGreaterThan(r.get('mid')!);
    expect(r.get('mid')!).toBeGreaterThan(r.get('weak')!);
  });
});
