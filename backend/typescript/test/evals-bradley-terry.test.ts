/**
 * ADR 0986 D5 — Bradley–Terry standings (`features/evals/bradleyTerry.ts`).
 *
 * The properties the arena relies on: the fit depends only on the multiset of
 * outcomes (never on the order verdicts were cast, unlike the retired running
 * Elo), a tie is symmetric, an unbeaten model stays finite, a disconnected graph
 * still fits, and more wins means a higher rating.
 *
 * Sabotage witnesses: removing the virtual reference tie reds "unbeaten…finite"
 * and "disconnected"; scoring a tie as a win for A reds "a tie…". The order case
 * pins a property, not a mechanism: the fit iterates models in sorted order, so no
 * single-line sabotage of input order reaches it (stated, not claimed as witnessed).
 */
import { describe, it, expect } from 'vitest';
import { bradleyTerry, BT_REFERENCE_RATING, type PairOutcome } from '../src/features/evals/bradleyTerry.js';

const o = (a: string, b: string, scoreA: number): PairOutcome => ({ a, b, scoreA });

describe('bradleyTerry', () => {
  it('is empty for no outcomes', () => {
    expect(bradleyTerry([]).size).toBe(0);
  });

  it('a tie is symmetric and leaves both at the reference', () => {
    const r = bradleyTerry([o('x', 'y', 0.5)]);
    expect(r.get('x')).toBeCloseTo(BT_REFERENCE_RATING, 6);
    expect(r.get('y')).toBeCloseTo(BT_REFERENCE_RATING, 6);
  });

  it('an unbeaten model stays finite and above its victim', () => {
    const r = bradleyTerry(Array.from({ length: 6 }, () => o('champ', 'chump', 1)));
    expect(Number.isFinite(r.get('champ'))).toBe(true);
    expect(r.get('champ')!).toBeGreaterThan(r.get('chump')!);
    expect(r.get('champ')!).toBeGreaterThan(BT_REFERENCE_RATING);
  });

  it('does not depend on the order outcomes arrive in', () => {
    const outcomes = [o('a', 'b', 1), o('b', 'c', 1), o('a', 'c', 0.5), o('c', 'a', 0), o('b', 'a', 1), o('d', 'a', 0)];
    const forward = bradleyTerry(outcomes);
    const reversed = bradleyTerry([...outcomes].reverse());
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
