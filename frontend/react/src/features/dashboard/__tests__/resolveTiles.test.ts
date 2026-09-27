/**
 * resolveTiles (ADR 0375 Phase 2) — the fail-closed effective-tile resolution.
 * Pins: tier gate, owning-feature-toggle gate, default derivation (null saved),
 * saved-layout merge (order/size/enabled), retired-id drop, deterministic order.
 */
import { describe, it, expect } from 'vitest';
import { lazy } from 'react';
import { resolveTiles } from '../resolveTiles.js';
import type { DashboardTileDef } from '../tileTypes.js';

const stub = lazy(async () => ({ default: () => null }));
const def = (over: Partial<DashboardTileDef> & Pick<DashboardTileDef, 'id'>): DashboardTileDef => ({
  id: over.id, label: over.id, labelKey: over.id, descriptionKey: `${over.id}-d`,
  icon: () => null, category: 'Work', requiredTier: 'workspace',
  defaultEnabled: true, defaultOrder: 0, defaultSize: 'half', resizable: true, component: stub,
  ...over,
});

const registry: DashboardTileDef[] = [
  def({ id: 'runs', defaultOrder: 0 }),
  def({ id: 'admin-only', requiredTier: 'admin', defaultOrder: 10 }),
  def({ id: 'crm', owningFeatureToggle: 'crm', defaultOrder: 20 }),
];
const allOn = (): boolean => true;

describe('resolveTiles', () => {
  it('gates admin tiles behind the admin tier (fail-closed)', () => {
    const asMember = resolveTiles({ registry, saved: null, toggleEnabled: allOn, isAdmin: false });
    expect(asMember.map((r) => r.def.id)).not.toContain('admin-only');
    const asAdmin = resolveTiles({ registry, saved: null, toggleEnabled: allOn, isAdmin: true });
    expect(asAdmin.map((r) => r.def.id)).toContain('admin-only');
  });

  it('gates a tile behind its owning-feature toggle (absent when off)', () => {
    const crmOff = resolveTiles({ registry, saved: null, toggleEnabled: (id) => id !== 'crm', isAdmin: true });
    expect(crmOff.map((r) => r.def.id)).not.toContain('crm');
    const crmOn = resolveTiles({ registry, saved: null, toggleEnabled: allOn, isAdmin: true });
    expect(crmOn.map((r) => r.def.id)).toContain('crm');
  });

  it('derives defaults when the caller has no saved layout', () => {
    const r = resolveTiles({ registry: [def({ id: 'runs', defaultEnabled: false, defaultOrder: 5, defaultSize: 'full' })], saved: null, toggleEnabled: allOn, isAdmin: true });
    expect(r[0]).toMatchObject({ order: 5, size: 'full', enabled: false });
  });

  it('merges the saved layout over defaults (order/size/enabled)', () => {
    const r = resolveTiles({
      registry: [def({ id: 'runs', defaultOrder: 0, defaultSize: 'half', defaultEnabled: true })],
      saved: [{ id: 'runs', order: 99, size: 'full', enabled: false }],
      toggleEnabled: allOn, isAdmin: true,
    });
    expect(r[0]).toMatchObject({ order: 99, size: 'full', enabled: false });
  });

  it('drops a saved id no longer in the registry (no migration, no crash)', () => {
    const r = resolveTiles({ registry, saved: [{ id: 'ghost', order: 0, size: 'half', enabled: true }, { id: 'runs', order: 1, size: 'half', enabled: true }], toggleEnabled: allOn, isAdmin: true });
    expect(r.map((x) => x.def.id)).not.toContain('ghost');
    expect(r.map((x) => x.def.id)).toContain('runs');
  });

  it('sorts by order, then id for ties', () => {
    const r = resolveTiles({
      registry: [def({ id: 'b', defaultOrder: 0 }), def({ id: 'a', defaultOrder: 0 }), def({ id: 'c', defaultOrder: -5 })],
      saved: null, toggleEnabled: allOn, isAdmin: true,
    });
    expect(r.map((x) => x.def.id)).toEqual(['c', 'a', 'b']);
  });
});
