import { createElement } from 'react';
import { describe, it, expect } from 'vitest';
import { FEATURES, WORKSPACE_NAV, ADMIN_NAV_GROUPS } from '../../features.js';
import type { FeatureRoute, FeatureTier, IconCmp } from '../../featureTypes.js';
import { resolveNav, mergeLayers, isCustomId, nextHeaderId } from '../resolveNav.js';
import { EMPTY_MENU_CONFIG, type MenuConfig } from '../types.js';

const allow = () => true;
const icon: IconCmp = () => null;

function feat(
  path: string,
  tier: FeatureTier,
  group: string,
  opts: { label?: string; order?: number; featureId?: string } = {},
): FeatureRoute {
  return {
    path,
    element: createElement('div'),
    tier,
    nav: { group, label: opts.label ?? path, icon, hint: '', order: opts.order, featureId: opts.featureId },
  };
}

const cfg = (over: Partial<MenuConfig> = {}): MenuConfig => ({ ...EMPTY_MENU_CONFIG, ...over });

describe('resolveNav — the empty == today invariant', () => {
  // ADR 0144/0145 added the `hiddenWhenFeature` inverse gate: under allow-all
  // every subsuming console toggle (access-hub, models, chat-deployment, …)
  // resolves enabled, so the entries each subsumes are hidden. The invariant
  // therefore holds against the static rails MINUS every subsumed item (derived
  // from the manifest so this stays correct as tags/consoles change).
  const subsumed = new Set(
    FEATURES.filter((f) => f.nav?.hiddenWhenFeature).map((f) => f.path),
  );
  const strip = <G extends { items: { to: string }[] }>(groups: G[]): G[] =>
    groups
      .map((g) => ({ ...g, items: g.items.filter((i) => !subsumed.has(i.to)) }))
      .filter((g) => g.items.length > 0);

  it('reproduces WORKSPACE_NAV / ADMIN_NAV_GROUPS (minus Access-Hub-subsumed items) with empty overrides + allow-all', () => {
    const r = resolveNav({ features: FEATURES, access: allow });
    expect(r.workspace).toEqual(strip(WORKSPACE_NAV));
    expect(r.admin).toEqual(strip(ADMIN_NAV_GROUPS));
  });
});

describe('resolveNav — feature-toggle hard gate', () => {
  const features = [
    feat('/a', 'workspace', 'Workspace', { featureId: 'flagA' }),
    feat('/core', 'workspace', 'Workspace'),
  ];

  it('drops a gated item when its feature is disabled', () => {
    const r = resolveNav({ features, access: (id) => id !== 'flagA' });
    expect(r.workspace.flatMap((g) => g.items.map((i) => i.to))).toEqual(['/core']);
  });

  it('keeps a gated item when enabled', () => {
    const r = resolveNav({ features, access: allow });
    expect(r.workspace.flatMap((g) => g.items.map((i) => i.to))).toEqual(['/a', '/core']);
  });

  it('a hidden:false override can NEVER reveal a disabled feature', () => {
    const user = cfg({ items: { '/a': { hidden: false } } });
    const r = resolveNav({ features, user, access: (id) => id !== 'flagA' });
    expect(r.workspace.flatMap((g) => g.items.map((i) => i.to))).not.toContain('/a');
  });
});

describe('resolveNav — hiddenWhenFeature inverse gate (ADR 0144)', () => {
  const features: FeatureRoute[] = [
    {
      path: '/keys',
      element: createElement('div'),
      tier: 'admin',
      nav: { group: 'Access & data', label: 'Keys', icon, hint: '', hiddenWhenFeature: 'access-hub' },
    },
    {
      path: '/access',
      element: createElement('div'),
      tier: 'admin',
      nav: { group: 'Access & data', label: 'Access', icon, hint: '', featureId: 'access-hub' },
    },
  ];

  it('access-hub OFF: the subsumed item shows, the hub is hidden (safe default)', () => {
    const r = resolveNav({ features, access: (id) => id !== 'access-hub' });
    const paths = r.admin.flatMap((g) => g.items.map((i) => i.to));
    expect(paths).toContain('/keys');
    expect(paths).not.toContain('/access');
  });

  it('access-hub ON: the subsumed item hides, the hub shows (collapsed)', () => {
    const r = resolveNav({ features, access: allow });
    const paths = r.admin.flatMap((g) => g.items.map((i) => i.to));
    expect(paths).not.toContain('/keys');
    expect(paths).toContain('/access');
  });
});

describe('resolveNav — visibility overrides', () => {
  it('hides a feature-gated item', () => {
    const features = [feat('/a', 'workspace', 'Workspace', { featureId: 'flagA' }), feat('/b', 'workspace', 'Workspace', { featureId: 'flagB' })];
    const user = cfg({ items: { '/a': { hidden: true } } });
    const r = resolveNav({ features, user, access: allow });
    expect(r.workspace.flatMap((g) => g.items.map((i) => i.to))).toEqual(['/b']);
  });

  it('IGNORES hidden on an always-on (no featureId) item', () => {
    const features = [feat('/chat', 'workspace', 'Workspace')];
    const user = cfg({ items: { '/chat': { hidden: true } } });
    const r = resolveNav({ features, user, access: allow });
    expect(r.workspace.flatMap((g) => g.items.map((i) => i.to))).toEqual(['/chat']);
  });
});

describe('resolveNav — tier + group moves', () => {
  it('moves an item between menus (workspace → admin)', () => {
    const features = [feat('/x', 'workspace', 'Workspace')];
    const user = cfg({ items: { '/x': { tier: 'admin', group: 'Platform' } } });
    const r = resolveNav({ features, user, access: allow });
    expect(r.workspace).toEqual([]);
    expect(r.admin.flatMap((g) => g.items.map((i) => i.to))).toEqual(['/x']);
    expect(r.admin[0]!.id).toBe('Platform');
  });

  it('re-homes an item under a different built-in header', () => {
    const features = [feat('/x', 'admin', 'Operations'), feat('/y', 'admin', 'Platform')];
    const user = cfg({ items: { '/x': { group: 'Platform' } } });
    const r = resolveNav({ features, user, access: allow });
    const platform = r.admin.find((g) => g.id === 'Platform');
    expect(platform?.items.map((i) => i.to).sort()).toEqual(['/x', '/y']);
    expect(r.admin.find((g) => g.id === 'Operations')).toBeUndefined(); // emptied → dropped
  });

  it('reorders within a group via the order override', () => {
    const features = [feat('/x', 'workspace', 'Workspace', { order: 1 }), feat('/y', 'workspace', 'Workspace', { order: 2 })];
    const user = cfg({ items: { '/y': { order: 0 } } });
    const r = resolveNav({ features, user, access: allow });
    expect(r.workspace[0]!.items.map((i) => i.to)).toEqual(['/y', '/x']);
  });
});

describe('resolveNav — headers (rename / reorder / custom)', () => {
  it('renames a built-in header and marks it custom (literal wins over i18n)', () => {
    const features = [feat('/x', 'admin', 'Platform')];
    const user = cfg({ headers: [{ id: 'Platform', tier: 'admin', label: 'Tooling' }] });
    const r = resolveNav({ features, user, access: allow });
    expect(r.admin[0]!.id).toBe('Platform');
    expect(r.admin[0]!.label).toBe('Tooling');
    expect(r.admin[0]!.custom).toBe(true);
  });

  it('reorders headers via the order override', () => {
    const features = [feat('/x', 'admin', 'Platform'), feat('/y', 'admin', 'Operations')];
    // default GROUP_ORDER: Operations before Platform. Force Platform first.
    const user = cfg({ headers: [{ id: 'Platform', tier: 'admin', order: -1 }] });
    const r = resolveNav({ features, user, access: allow });
    expect(r.admin.map((g) => g.id)).toEqual(['Platform', 'Operations']);
  });

  it('places an item under a custom header', () => {
    const features = [feat('/x', 'admin', 'Platform')];
    const user = cfg({
      items: { '/x': { group: 'hdr_1' } },
      headers: [{ id: 'hdr_1', tier: 'admin', label: 'My tools', custom: true }],
    });
    const r = resolveNav({ features, user, access: allow });
    expect(r.admin.map((g) => g.id)).toEqual(['hdr_1']);
    expect(r.admin[0]!.label).toBe('My tools');
  });

  it('falls back to the declared group when an item points at a deleted custom header', () => {
    const features = [feat('/x', 'admin', 'Platform')];
    const user = cfg({ items: { '/x': { group: 'hdr_99' } } }); // hdr_99 not in headers
    const r = resolveNav({ features, user, access: allow });
    expect(r.admin.map((g) => g.id)).toEqual(['Platform']);
  });
});

describe('resolveNav — two-layer precedence (tenant ← user)', () => {
  it('user override wins per field; tenant fills the rest', () => {
    const tenant: MenuConfig = { items: { '/x': { group: 'Operations', order: 5 } }, headers: [] };
    const user: MenuConfig = { items: { '/x': { group: 'Platform' } }, headers: [] };
    const merged = mergeLayers(tenant, user);
    expect(merged.items['/x']).toEqual({ group: 'Platform', order: 5 });
  });

  it('user can re-show a tenant-hidden gated item', () => {
    const features = [feat('/a', 'admin', 'Platform', { featureId: 'flagA' })];
    const tenant: MenuConfig = { items: { '/a': { hidden: true } }, headers: [] };
    const user: MenuConfig = { items: { '/a': { hidden: false } }, headers: [] };
    const r = resolveNav({ features, tenant, user, access: allow });
    expect(r.admin.flatMap((g) => g.items.map((i) => i.to))).toEqual(['/a']);
  });

  it('user header override wins over tenant', () => {
    const tenant: MenuConfig = { items: {}, headers: [{ id: 'Platform', tier: 'admin', label: 'Admin label' }] };
    const user: MenuConfig = { items: {}, headers: [{ id: 'Platform', tier: 'admin', label: 'My label' }] };
    const merged = mergeLayers(tenant, user);
    expect(merged.headers.find((h) => h.id === 'Platform')?.label).toBe('My label');
  });
});

describe('header id helpers', () => {
  it('isCustomId distinguishes hdr_* from built-in labels', () => {
    expect(isCustomId('hdr_1')).toBe(true);
    expect(isCustomId('Platform')).toBe(false);
  });

  it('nextHeaderId skips taken ids deterministically', () => {
    expect(nextHeaderId([])).toBe('hdr_1');
    expect(nextHeaderId(['hdr_1', 'hdr_2'])).toBe('hdr_3');
    expect(nextHeaderId(['hdr_2'])).toBe('hdr_1');
  });
});
