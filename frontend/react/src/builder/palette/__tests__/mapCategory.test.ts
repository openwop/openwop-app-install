/**
 * grade-ux U-4 / ADR 0767 D4 — every v2 spec `category` maps to a palette group
 * by an explicit decision, not by falling through the default.
 *
 * The palette groups are READ from `CATEGORY_LABEL_KEYS` (a `Record<NodeCategory, …>`,
 * so it holds every group the type declares), never copied here: ADR 0955 P5 added
 * `journey` to the type and the labels, but not to `mapCategory`, and the journey
 * nodes fell into Control. A literal list in this file would have stayed green.
 * Breaks if a group is missing from `mapCategory`'s pass-through, `canvas` stops
 * mapping to Data, or the default stops being Control.
 */
import { describe, expect, it } from 'vitest';
import { mapCategory } from '../catalogRegistry.js';
import { CATEGORY_LABEL_KEYS } from '../categoryLabels.js';

describe('mapCategory', () => {
  it('passes every palette group through', () => {
    const groups = Object.keys(CATEGORY_LABEL_KEYS);
    // The six groups today (flow, data, ai, control, integration, journey). A seventh
    // added to the type must reach this loop and pass through mapCategory.
    expect(groups).toHaveLength(6);
    for (const g of groups) expect(mapCategory(g), g).toBe(g);
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
