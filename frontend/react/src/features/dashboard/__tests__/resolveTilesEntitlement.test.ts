/**
 * ADR 0419 — a LOCKED feature's tile must not reach the dashboard.
 *
 * `owningFeatureToggle` gated tiles on the toggle only. A paid feature whose
 * toggle is ON but whose plan does not entitle it (`advisory-board` on the free
 * plan) therefore rendered a tile whose every read 403s with
 * "Your plan (free) does not include this feature" — a permanently-failing tile
 * plus a 403 in the console on every dashboard load.
 */
import { describe, it, expect } from 'vitest';
import { resolveTiles, type ResolveInput } from '../resolveTiles.js';
import type { DashboardTileDef } from '../tileTypes.js';

const def = (over: Partial<DashboardTileDef> & { id: string }): DashboardTileDef =>
  ({
    label: over.id, labelKey: over.id, descriptionKey: over.id,
    icon: (() => null) as unknown as DashboardTileDef['icon'],
    category: 'Work', requiredTier: 'workspace',
    defaultEnabled: true, defaultOrder: 10, defaultSize: 'half', resizable: true,
    component: (() => null) as unknown as DashboardTileDef['component'],
    ...over,
  }) as DashboardTileDef;

const base = (over: Partial<ResolveInput>): ResolveInput => ({
  registry: [], saved: null, toggleEnabled: () => true, isAdmin: false, ...over,
});

describe('resolveTiles — plan entitlement', () => {
  const registry = [
    def({ id: 'advisory-boards', owningFeatureToggle: 'advisory-board', defaultOrder: 10 }),
    def({ id: 'todos', defaultOrder: 20 }), // ungated core tile
  ];

  it('drops a tile whose owning feature is LOCKED', () => {
    const out = resolveTiles(base({ registry, featureLocked: (id) => id === 'advisory-board' }));
    expect(out.map((t) => t.def.id)).toEqual(['todos']);
  });

  it('keeps the tile when the plan entitles it', () => {
    const out = resolveTiles(base({ registry, featureLocked: () => false }));
    expect(out.map((t) => t.def.id)).toEqual(['advisory-boards', 'todos']);
  });

  it('never gates an ungated tile, whatever the lock predicate says', () => {
    // A core tile has no owningFeatureToggle — entitlement must not touch it.
    const out = resolveTiles(base({ registry, featureLocked: () => true }));
    expect(out.map((t) => t.def.id)).toEqual(['todos']);
  });

  it('is a no-op when no predicate is supplied (back-compat)', () => {
    const out = resolveTiles(base({ registry }));
    expect(out.map((t) => t.def.id)).toEqual(['advisory-boards', 'todos']);
  });

  it('toggle-off still wins independently of entitlement', () => {
    const out = resolveTiles(base({
      registry,
      toggleEnabled: (id) => id !== 'advisory-board',
      featureLocked: () => false,
    }));
    expect(out.map((t) => t.def.id)).toEqual(['todos']);
  });
});
