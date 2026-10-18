/**
 * grade-ux U-4 / ADR 0767 D4 — every v2 spec `category` maps to a palette group
 * by an explicit decision, not by falling through the default.
 */
import { describe, expect, it } from 'vitest';
import { mapCategory } from '../catalogRegistry.js';

describe('mapCategory', () => {
  it('passes the five palette groups through', () => {
    for (const g of ['data', 'ai', 'flow', 'control', 'integration'] as const) expect(mapCategory(g)).toBe(g);
  });

  // CEILING: `chat` and `coordination` map to Control, which is ALSO the default,
  // so deleting their explicit `case` is behaviour-identical — no test can see
  // the explicitness for those two. `canvas` (→ Data) is observable, and the
  // shared default is pinned by the 'unknown value' case below.
  it('maps each v2 spec value the palette has no group for, explicitly', () => {
    expect(mapCategory('canvas')).toBe('data');
    expect(mapCategory('chat')).toBe('control');
    expect(mapCategory('coordination')).toBe('control');
  });

  it('an unknown value still lands in Control', () => {
    expect(mapCategory('something-new')).toBe('control');
  });
});
