/**
 * CDP-E — journey experiment/holdout split (ADR 0267). The bucketing is
 * deterministic + replay-stable (same contact → same arm), keyed on contactId,
 * and honors the holdout percentage at the population level.
 *
 * Sabotage that reds it (w38 probes): a random bucket (replay instability); a
 * mis-scaled percentage boundary; an inverted arm; ignoring the experimentId salt.
 * The 0%/100% legs walk the SAME 4000-contact population as the split
 * case, so a boundary drift cannot hide behind a handful of ids.
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
    for (let i = 0; i < 4000; i++) {
      const id = `crm:${i}`;
      expect(holdoutArm(id, 'e', 0).arm).toBe('treatment');
      expect(holdoutArm(id, 'e', 100).arm).toBe('control');
    }
  });
  it('splits the population roughly by the holdout percentage', () => {
    let control = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) if (holdoutArm(`crm:${i}`, 'exp', 25).arm === 'control') control++;
    const pct = (control / N) * 100;
    // The hash is deterministic, so this band cannot flake; ±1.5pp is ~2 SD at N=4000.
    expect(pct).toBeGreaterThan(23.5);
    expect(pct).toBeLessThan(26.5);
  });
  it('different experiments bucket independently', () => {
    // the same contact can be control in one experiment and treatment in another
    const arms = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((e) => holdoutArm('crm:x', e, 50).arm));
    expect(arms.size).toBe(2); // both arms appear across experiments (not pinned to one)
  });
});
