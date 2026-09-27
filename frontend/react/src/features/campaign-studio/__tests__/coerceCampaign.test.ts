/**
 * R2 CS-SP-9 — the starter channel is a FRESH-doc affordance, never a repair.
 * The rule under test: fabricate 'New channel · email' ONLY when the channels
 * key is absent (coerceDoc({}) — how the chassis synthesizes a new doc); any
 * PRESENT value that coerces to nothing (empty array, non-array, array of
 * garbage) renders empty, so a later Save cannot persist fabricated data over
 * a malformed stored doc.
 */
import { describe, it, expect } from 'vitest';
import { coerceCampaign } from '../definition.js';

describe('coerceCampaign — CS-SP-9 starter-channel rule', () => {
  it('fabricates the starter for a FRESH doc (channels key absent)', () => {
    expect(coerceCampaign({}).channels).toEqual([{ name: 'New channel', type: 'email' }]);
  });

  it('preserves real channels untouched', () => {
    const channels = [{ name: 'Launch email', type: 'email', budget: 500 }];
    expect(coerceCampaign({ name: 'C', channels }).channels).toEqual(channels);
  });

  it('renders a stored EMPTY array as empty — no fabrication', () => {
    expect(coerceCampaign({ name: 'C', channels: [] }).channels).toEqual([]);
  });

  it('renders a NON-ARRAY stored value as empty — no fabrication', () => {
    expect(coerceCampaign({ name: 'C', channels: 'corrupted' }).channels).toEqual([]);
    expect(coerceCampaign({ name: 'C', channels: { name: 'x' } }).channels).toEqual([]);
  });

  it('renders an array of garbage as empty — no fabrication', () => {
    expect(coerceCampaign({ name: 'C', channels: [null, 'x', 42] }).channels).toEqual([]);
  });

  it('keeps the valid subset of a partially-malformed array', () => {
    const good = { name: 'Social push', type: 'social' };
    expect(coerceCampaign({ name: 'C', channels: [null, good] }).channels).toEqual([good]);
  });
});
