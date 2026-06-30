import { createElement } from 'react';
import { describe, it, expect } from 'vitest';
import { FEATURES } from '../../../chrome/features.js';
import type { FeatureRoute } from '../../../chrome/featureTypes.js';
import { scopesOf, tabIdOf, visibleHubRoutes, type HubRoute } from '../../../chrome/hubProjection.js';

const route = (path: string, hubTab: FeatureRoute['hubTab']): FeatureRoute => ({
  path,
  element: createElement('div'),
  tier: 'admin',
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
    { path: '/not-a-tab', element: createElement('div'), tier: 'admin' }, // no hubTab
  ];

  it('keeps only routes with a hubTab', () => {
    const ids = visibleHubRoutes(features, () => true, 'access', ACCESS_GROUPS).map(tabIdOf);
    expect(ids).not.toContain('not-a-tab');
  });

  it('orders by group (credentials → identity) then hubTab.order', () => {
    const ids = visibleHubRoutes(features, () => true, 'access', ACCESS_GROUPS).map(tabIdOf);
    expect(ids).toEqual(['keys', 'connections', 'users', 'firewall']);
  });

  it('gates a tab whose featureId is disabled', () => {
    const ids = visibleHubRoutes(features, (id) => id !== 'capability-firewall', 'access', ACCESS_GROUPS).map(tabIdOf);
    expect(ids).not.toContain('firewall');
    expect(ids).toContain('keys');
  });

  it('scopesOf defaults to workspace-only, honours explicit scopes', () => {
    const visible = visibleHubRoutes(features, () => true, 'access', ACCESS_GROUPS);
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
    expect(visibleHubRoutes(mixed, () => true, 'access').map(tabIdOf)).toEqual(['legacy', 'keys']);
    expect(visibleHubRoutes(mixed, () => true, 'models').map(tabIdOf)).toEqual(['leaderboard']);
    expect(visibleHubRoutes(mixed, () => true, 'chat-deployment').map(tabIdOf)).toEqual(['scheduled-chats']);
  });
});

describe('Access Hub manifest wiring (the real FEATURES)', () => {
  const hub = visibleHubRoutes(FEATURES, () => true, 'access', ACCESS_GROUPS);
  const ids = hub.map(tabIdOf);

  it('tags exactly the Credentials + Identity surfaces as hub tabs', () => {
    // Users/People is intentionally NOT a hub tab — it keeps its own /users
    // surface (ADR 0144 §correction).
    expect(new Set(ids)).toEqual(
      new Set(['keys', 'connections', 'voice', 'endpoints', 'orgs', 'capability-firewall']),
    );
  });

  it('groups them correctly', () => {
    const groupOf = (id: string) => hub.find((r) => tabIdOf(r) === id)!.hubTab.group;
    for (const id of ['keys', 'connections', 'voice', 'endpoints']) expect(groupOf(id)).toBe('credentials');
    for (const id of ['orgs', 'capability-firewall']) expect(groupOf(id)).toBe('identity');
  });

  it('does NOT tag Users/People as a hub tab (it keeps its own /users surface)', () => {
    expect(ids).not.toContain('users');
    const users = FEATURES.find((r) => r.path === '/users');
    expect(users?.hubTab).toBeUndefined();
    expect(users?.nav?.hiddenWhenFeature).toBeUndefined(); // its rail entry never hides
  });

  it('only Connections is Personal-scoped (OQ-5: Keys is Workspace-only)', () => {
    const personal = hub.filter((r) => scopesOf(r).includes('personal')).map(tabIdOf);
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
