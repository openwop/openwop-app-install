import { describe, it, expect } from 'vitest';
import { FEATURES, navGroups } from '../features.js';
import { navLabel } from '../navText.js';

/**
 * Issue #5786 §5 — two nav-shape defects an adopter saw in the stock rail.
 *
 * 1. Two entries in one group shared an icon (Scheduled chats + Chat widgets in
 *    Workspace, Analytics + Performance in Marketing), so the icon told them
 *    apart from nothing. Within a tier's group every icon is distinct.
 * 2. Settings had no `order`, so it sorted with the other unordered entries in
 *    declaration order and landed mid-list. It is the last Workspace entry.
 */
const byTier = (tier: string) => navGroups(FEATURES.filter((f) => f.tier === tier));

describe('nav group hygiene (#5786 §5)', () => {
  it('no two entries in one group share an icon', () => {
    const clashes: string[] = [];
    for (const tier of ['workspace', 'admin']) {
      for (const g of byTier(tier)) {
        g.items.forEach((a, n) => {
          for (const b of g.items.slice(n + 1)) {
            if (a.icon !== b.icon) continue;
            // Never on screen together: one hides when the other's feature is on.
            const exclusive = (x: typeof a, y: typeof a) => Boolean(x.hiddenWhenFeature) && x.hiddenWhenFeature === y.featureId;
            if (exclusive(a, b) || exclusive(b, a)) continue;
            clashes.push(`${tier}/${g.id}: "${navLabel(a)}" and "${navLabel(b)}"`);
          }
        });
      }
    }
    expect(clashes).toEqual([]);
  });

  it('Settings is the last Workspace entry, and every Workspace entry declares an order', () => {
    const ws = byTier('workspace').find((g) => g.id === 'Workspace');
    expect((ws?.items.at(-1) ? navLabel(ws.items.at(-1)!) : undefined)).toBe('Settings');
    // An unordered entry sorts after every ordered one, so a new one without an
    // order would land below Settings again.
    expect(ws?.items.filter((i) => i.order === undefined).map((i) => navLabel(i))).toEqual([]);
  });
});
