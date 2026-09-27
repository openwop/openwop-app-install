/**
 * CDP-E — journey experiment/holdout split (ADR 0267). The bucketing is
 * deterministic + replay-stable (same contact → same arm), keyed on contactId,
 * and honors the holdout percentage at the population level.
 */
import { describe, expect, it } from 'vitest';
import { holdoutArm } from '../src/features/campaign-journeys/surface.js';

describe('CDP-E holdoutArm', () => {
  it('is deterministic for the same (contactId, experimentId) — replay-stable', () => {
    const a = holdoutArm('crm:abc', 'exp-1', 20);
    const b = holdoutArm('crm:abc', 'exp-1', 20);
    expect(a).toEqual(b);
  });
  it('0% holdout → everyone treatment; 100% → everyone control', () => {
    for (const id of ['crm:1', 'crm:2', 'crm:3', 'crm:4', 'crm:5']) {
      expect(holdoutArm(id, 'e', 0).arm).toBe('treatment');
      expect(holdoutArm(id, 'e', 100).arm).toBe('control');
    }
  });
  it('splits the population roughly by the holdout percentage', () => {
    let control = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) if (holdoutArm(`crm:${i}`, 'exp', 25).arm === 'control') control++;
    const pct = (control / N) * 100;
    expect(pct).toBeGreaterThan(20);
    expect(pct).toBeLessThan(30); // ~25% ± tolerance
  });
  it('different experiments bucket independently', () => {
    // the same contact can be control in one experiment and treatment in another
    const arms = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((e) => holdoutArm('crm:x', e, 50).arm));
    expect(arms.size).toBe(2); // both arms appear across experiments (not pinned to one)
  });
});
