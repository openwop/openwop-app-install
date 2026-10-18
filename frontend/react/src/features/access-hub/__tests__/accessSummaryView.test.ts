/**
 * ADR 0864 — the projection from the summary to the console. The load-bearing
 * rule: a section the server omitted shows NO status and no card, never a 0.
 *
 * `t` is a real i18next instance over the feature's own `en` catalog, so the
 * expectations are the rendered English — a key the view names that is missing
 * from the catalog (or has no plural forms) renders the raw key and fails.
 * Red if an omitted section draws a status/card (`w27g2-asv-omitted-endpoints`),
 * the connection tone / scope axis / tab gating / banner choice / expired /
 * firewall / members wiring breaks (`asv-*`), or a failed read draws anything.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { accessSummaryView, type AccessSummary, type ConnectionCounts } from '../accessSummary.js';
import { messages as en } from '../i18n/en.js';

const i18n = i18next.createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', ns: ['access-hub'], defaultNS: 'access-hub', resources: { en: { 'access-hub': en } }, interpolation: { escapeValue: false } });
});
const t = i18n.t; // i18next binds its member functions, so the detached `t` is safe
const ALL = ['keys', 'connections', 'voice', 'endpoints', 'mcp', 'api-keys', 'orgs', 'capability-firewall'];
const none: ConnectionCounts = { count: 0, needsReconnect: 0, reconnect: [] };

const full: AccessSummary = {
  keys: { count: 2 },
  connections: {
    workspace: { count: 3, needsReconnect: 1, reconnect: [{ connectionId: 'c1', displayName: 'Google Drive', provider: 'google' }] },
    personal: { count: 1, needsReconnect: 0, reconnect: [] },
  },
  voice: { on: false },
  apiKeys: { count: 4, expired: 0 },
  mcpClients: { count: 0 },
  orgs: { count: 1, members: 6 },
  firewall: { isDefault: true, rules: 0 },
  endpoints: { count: 2 },
};

describe('accessSummaryView (ADR 0864)', () => {
  it('a failed read draws nothing', () => {
    expect(accessSummaryView(null, 'workspace', ALL, t)).toEqual({ status: {}, cards: [], banner: null });
  });

  it('statuses for every section the server returned', () => {
    const v = accessSummaryView(full, 'workspace', ALL, t);
    expect(v.status).toEqual({
      keys: { meta: '2' },
      connections: { meta: '1 issue', metaTone: 'attention' },
      voice: { meta: 'Off' },
      mcp: { meta: '0' },
      'api-keys': { meta: '4' },
      orgs: { meta: '1' },
      'capability-firewall': { meta: 'Default' },
      endpoints: { meta: '2' },
    });
  });

  it('an omitted section gets no status and no card — never a zero', () => {
    const { apiKeys: _a, mcpClients: _m, endpoints: _e, ...rest } = full;
    const v = accessSummaryView(rest, 'workspace', ALL, t);
    expect(v.status).not.toHaveProperty('endpoints');
    expect(v.status).not.toHaveProperty('api-keys');
    expect(v.status).not.toHaveProperty('mcp');
    expect(v.cards.map((c) => c.key)).toEqual(['keys', 'connections', 'orgs']);
  });

  it('cards in design order; a broken connection tints its card and names itself in the banner', () => {
    const v = accessSummaryView(full, 'workspace', ALL, t);
    expect(v.cards.map((c) => c.key)).toEqual(['keys', 'connections', 'mcp', 'orgs']);
    expect(v.cards[1]).toMatchObject({ value: 3, subTone: 'attention', sub: '1 needs reconnecting' });
    expect(v.cards[3]).toMatchObject({ label: 'Members', value: 6, sub: 'In 1 organization' });
    expect(v.banner?.title).toBe('Google Drive needs reconnecting.');
  });

  it('several broken connections → a counted banner', () => {
    // The server always names up to five (MAX_NAMED), so a real payload carries names:
    // the COUNT, not an empty list, must be what picks the counted banner.
    const reconnect = [
      { connectionId: 'c1', displayName: 'Drive', provider: 'google' },
      { connectionId: 'c2', displayName: 'Slack', provider: 'slack' },
    ];
    const s: AccessSummary = { connections: { workspace: { count: 5, needsReconnect: 2, reconnect }, personal: none } };
    expect(accessSummaryView(s, 'workspace', ALL, t).banner?.title).toBe('2 connections need reconnecting.');
  });

  it('Personal scope reads the personal axis and draws no cards', () => {
    const v = accessSummaryView(full, 'personal', ['connections'], t);
    expect(v.status.connections).toEqual({ meta: '1' });
    expect(v.cards).toEqual([]);
    expect(v.banner).toBeNull();
  });

  it('never points at a section the caller cannot open', () => {
    const v = accessSummaryView(full, 'workspace', ['mcp', 'api-keys'], t);
    expect(v.cards.map((c) => c.key)).toEqual(['mcp']);
    expect(v.banner).toBeNull();
  });

  it('expired API keys and stored firewall rules read as such', () => {
    const v = accessSummaryView({ apiKeys: { count: 3, expired: 1 }, firewall: { isDefault: false, rules: 2 } }, 'workspace', ALL, t);
    expect(v.status['api-keys']).toEqual({ meta: '1 expired', metaTone: 'attention' });
    expect(v.status['capability-firewall']).toEqual({ meta: '2 rules' });
  });
});
