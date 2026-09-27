/**
 * GRADING PROBE — "Editable dashboard" (FEATURES.md ordinal 233). Evidence only.
 * GREEN + CI-safe (pure resolver; no React render, no network, no store).
 *
 * Witnesses Headline #4 — FAIL-CLOSED tile resolution (`resolveTiles`), the
 * mechanism behind "no pre-gate data leak": a tile whose owning feature toggle is
 * OFF, whose tier the caller lacks (admin), or whose plan is LOCKED (ADR 0419) is
 * ABSENT from BOTH the grid and the picker — so its data-fetching body never
 * mounts and cannot read before the gate resolves. This is the confidentiality
 * mechanism that keeps the dashboard from becoming an un-gated read surface (the
 * `/grade-code` "sibling-door" angle came back clean partly because of this gate).
 *
 * EDBP-1: an admin-tier tile is hidden for a non-admin, shown for an admin.
 * EDBP-2: a toggle-OFF tile is hidden; the same tile with the toggle ON is shown.
 * EDBP-3: a plan-LOCKED tile (toggle on, plan lacks it) is hidden (fail-closed).
 * EDBP-4: an ungated workspace tile is always available (control).
 */
import { describe, it, expect } from 'vitest';
import { lazy } from 'react';
import { resolveTiles } from '../resolveTiles.js';
import type { DashboardTileDef } from '../tileTypes.js';

const Icon = () => null;
const Comp = lazy(() => Promise.resolve({ default: () => null }));

const def = (over: Partial<DashboardTileDef> & { id: string }): DashboardTileDef => ({
  label: over.id, labelKey: `t.${over.id}`, descriptionKey: `d.${over.id}`, icon: Icon,
  category: 'Work', requiredTier: 'workspace', defaultEnabled: true, defaultOrder: 0,
  defaultSize: 'half', resizable: true, component: Comp, ...over,
});

const ids = (r: ReturnType<typeof resolveTiles>) => r.map((t) => t.def.id);

describe('Editable dashboard — fail-closed tile resolution (by execution)', () => {
  const adminTile = def({ id: 'admin-only', requiredTier: 'admin' });
  const crmTile = def({ id: 'crm', owningFeatureToggle: 'crm' });
  const openTile = def({ id: 'open' }); // no toggle, workspace tier — always available

  it('EDBP-1: admin-tier tile hidden for a non-admin, shown for an admin', () => {
    const reg = [adminTile, openTile];
    expect(ids(resolveTiles({ registry: reg, saved: null, toggleEnabled: () => true, isAdmin: false })))
      .toEqual(['open']); // admin tile absent
    expect(ids(resolveTiles({ registry: reg, saved: null, toggleEnabled: () => true, isAdmin: true })).sort())
      .toEqual(['admin-only', 'open']);
  });

  it('EDBP-2: toggle-OFF tile hidden; toggle-ON tile shown', () => {
    const reg = [crmTile, openTile];
    expect(ids(resolveTiles({ registry: reg, saved: null, toggleEnabled: () => false, isAdmin: false })))
      .toEqual(['open']); // crm toggle off → absent
    expect(ids(resolveTiles({ registry: reg, saved: null, toggleEnabled: () => true, isAdmin: false })).sort())
      .toEqual(['crm', 'open']);
  });

  it('EDBP-3: plan-LOCKED tile hidden even with toggle on (fail-closed, ADR 0419)', () => {
    const r = resolveTiles({
      registry: [crmTile, openTile], saved: null,
      toggleEnabled: () => true, isAdmin: false, featureLocked: (id) => id === 'crm',
    });
    expect(ids(r)).toEqual(['open']); // locked crm absent from grid AND picker
  });

  it('EDBP-4 (control): an ungated workspace tile is always available', () => {
    expect(ids(resolveTiles({ registry: [openTile], saved: null, toggleEnabled: () => false, isAdmin: false })))
      .toEqual(['open']);
  });
});
