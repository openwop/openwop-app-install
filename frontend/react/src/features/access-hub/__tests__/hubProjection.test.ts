/**
 * ADR 0144 / ADR 0145 — the hub tab projection (`chrome/hubProjection.ts`) and the real
 * Access Hub manifest wiring. Protected: the tier filter is the AHC-1 / MHC-1 / CDC-1 /
 * CSCC-1 defense-in-depth — an `admin`-tier tab must be dropped for a non-admin caller
 * by the projection ITSELF, not only by the page shell.
 *
 * Red if the hubTab filter, hub discriminator default, toggle gate, tier gate, group
 * ordering or scope default breaks (`w27g2-hp-*`), or the manifest stops tagging exactly
 * the Credentials + Identity surfaces in their groups.
 *
 * Every projection call runs INSIDE a case: a manifest call at describe level throws at
 * COLLECTION time, which errors the whole file instead of failing the cases it breaks.
 */
import { createElement } from 'react';
import { describe, it, expect } from 'vitest';
import { FEATURES } from '../../../chrome/features.js';
import type { FeatureHubTab, FeatureRoute } from '../../../chrome/featureTypes.js';
import { scopesOf, tabIdOf, visibleHubRoutes, type HubRoute } from '../../../chrome/hubProjection.js';

const route = (
  path: string,
  hubTab: FeatureHubTab,
  tier: FeatureRoute['tier'] = 'admin',
): FeatureRoute => ({
  path,
  element: createElement('div'),
  tier,
  archetype: 'admin',
  hubTab,
});

/** Access Hub rail clusters (mirrors AccessHubPage's GROUP_ORDER). */
const ACCESS_GROUPS = ['credentials', 'identity'];

describe('visibleHubRoutes — projection logic', () => {
  const features: FeatureRoute[] = [
    route('/users', { group: 'identity', order: 1 }),
    route('/keys', { group: 'credentials', order: 0 }),
    route('/firewall', { group: 'identity', order: 2, featureId: 'capability-firewall' }),
    route('/connections', { group: 'credentials', order: 1, scopes: ['workspace', 'personal'] }),
    { path: '/not-a-tab', element: createElement('div'), tier: 'admin', archetype: 'admin' }, // no hubTab
  ];

  it('orders by group (credentials → identity) then hubTab.order', () => {
    // Also the hubTab filter (folded in from its own case): the fixture's hubTab-less
    // route is dropped. Without the filter the projection throws on it, which reds here.
    const ids = visibleHubRoutes(features, () => true, true, 'access', ACCESS_GROUPS).map(tabIdOf);
    expect(ids).not.toContain('not-a-tab');
    expect(ids).toEqual(['keys', 'connections', 'users', 'firewall']);
  });

  it('gates a tab whose featureId is disabled', () => {
    const ids = visibleHubRoutes(features, (id) => id !== 'capability-firewall', true, 'access', ACCESS_GROUPS).map(
      tabIdOf,
    );
    expect(ids).not.toContain('firewall');
    expect(ids).toContain('keys');
  });

  it('scopesOf defaults to workspace-only, honours explicit scopes', () => {
    const visible = visibleHubRoutes(features, () => true, true, 'access', ACCESS_GROUPS);
    const byId = (id: string) => visible.find((r) => tabIdOf(r) === id) as HubRoute;
    expect(scopesOf(byId('keys'))).toEqual(['workspace']);
    expect(scopesOf(byId('connections'))).toEqual(['workspace', 'personal']);
  });

  // ADR 0145 — the `hub` discriminator keeps each console's tabs separate.
  it('filters by the hub discriminator (no cross-console leakage)', () => {
    const mixed: FeatureRoute[] = [
      route('/keys', { hub: 'access', group: 'credentials' }),
      route('/leaderboard', { hub: 'models', order: 2 }),
      route('/scheduled-chats', { hub: 'chat-deployment', order: 1 }),
      route('/legacy', { order: 0 }), // no hub ⇒ defaults to 'access'
    ];
    expect(visibleHubRoutes(mixed, () => true, true, 'access').map(tabIdOf)).toEqual(['legacy', 'keys']);
    expect(visibleHubRoutes(mixed, () => true, true, 'models').map(tabIdOf)).toEqual(['leaderboard']);
    expect(visibleHubRoutes(mixed, () => true, true, 'chat-deployment').map(tabIdOf)).toEqual(['scheduled-chats']);
  });

  // AHC-1 / MHC-1 / CDC-1 / CSCC-1 — the projection must gate an `admin`-tier tab
  // for a non-admin caller ITSELF, not lean on the coarse <AdminLayout> shell + an
  // all-tabs-admin invariant. `workspace`/`public` tiers stay visible to everyone.
  describe('tier gating (defense-in-depth, not toggle-only)', () => {
    const mixedTiers: FeatureRoute[] = [
      route('/keys', { group: 'credentials', order: 0 }, 'workspace'), // everyone
      route('/firewall', { group: 'identity', order: 1 }, 'admin'), // admin-only
      route('/status', { group: 'identity', order: 2 }, 'public'), // everyone
    ];

    it('drops the admin-tier tab for a non-admin caller', () => {
      const ids = visibleHubRoutes(mixedTiers, () => true, false, 'access', ACCESS_GROUPS).map(tabIdOf);
      expect(ids).not.toContain('firewall'); // admin-tier — gated
      expect(ids).toEqual(['keys', 'status']); // workspace + public — visible to all
    });

    it('keeps the admin-tier tab for an admin caller', () => {
      const ids = visibleHubRoutes(mixedTiers, () => true, true, 'access', ACCESS_GROUPS).map(tabIdOf);
      expect(ids).toEqual(['keys', 'firewall', 'status']); // all three visible to admin
    });
  });
});

describe('Access Hub manifest wiring (the real FEATURES)', () => {
  const adminHub = () => visibleHubRoutes(FEATURES, () => true, true, 'access', ACCESS_GROUPS);

  it('ADR 0788 MCPUX-1 — a MEMBER (non-admin) reaches the AI clients tab; the admin-only tabs stay hidden', () => {
    const memberIds = visibleHubRoutes(FEATURES, () => true, false, 'access', ACCESS_GROUPS).map(tabIdOf);
    expect(memberIds).toContain('mcp');
    // ADR 0800 D2 — the API keys tab is self-service for the same reason.
    expect(memberIds).toContain('api-keys');
    expect(memberIds).not.toContain('keys');
  });

  it('tags exactly the Credentials + Identity surfaces as hub tabs', () => {
    // Users/People is intentionally NOT a hub tab — it keeps its own /users
    // surface (ADR 0144 §correction).
    expect(new Set(adminHub().map(tabIdOf))).toEqual(
      new Set(['keys', 'connections', 'voice', 'endpoints', 'mcp', 'api-keys', 'orgs', 'capability-firewall']),
    );
  });

  it('groups them correctly', () => {
    const hub = adminHub();
    const groupOf = (id: string) => hub.find((r) => tabIdOf(r) === id)!.hubTab.group;
    for (const id of ['keys', 'connections', 'voice', 'endpoints', 'mcp', 'api-keys']) expect(groupOf(id)).toBe('credentials');
    for (const id of ['orgs', 'capability-firewall']) expect(groupOf(id)).toBe('identity');
  });

  it('does NOT tag Users/People as a hub tab (it keeps its own /users surface)', () => {
    expect(adminHub().map(tabIdOf)).not.toContain('users');
    const users = FEATURES.find((r) => r.path === '/users');
    expect(users?.hubTab).toBeUndefined();
    expect(users?.nav?.hiddenWhenFeature).toBeUndefined(); // its rail entry never hides
  });

  it('only Connections is Personal-scoped (OQ-5: Keys is Workspace-only)', () => {
    const personal = adminHub().filter((r) => scopesOf(r).includes('personal')).map(tabIdOf);
    expect(personal).toEqual(['connections']);
  });

  it('Voice + Endpoints are nav-less (hub-only surfaces)', () => {
    const voice = FEATURES.find((r) => r.path === '/access/voice');
    const endpoints = FEATURES.find((r) => r.path === '/access/endpoints');
    expect(voice?.nav).toBeUndefined();
    expect(endpoints?.nav).toBeUndefined();
  });

  it('the /access hub route is always-on (no featureId) and is not itself a tab', () => {
    const access = FEATURES.find((r) => r.path === '/access');
    // Graduated off its toggle (ADR 0144 §Correction 2026-06-26) — permanent surface.
    expect(access?.nav?.featureId).toBeUndefined();
    expect(access?.hubTab).toBeUndefined(); // the container is not itself a tab
  });

  it('the subsumed surfaces have no standalone nav (reached only via the hub)', () => {
    for (const path of ['/keys', '/connections', '/orgs', '/capability-firewall']) {
      expect(FEATURES.find((r) => r.path === path)?.nav).toBeUndefined();
    }
  });
});
