/**
 * ADR 0864 — the projection from the summary to the console. The load-bearing
 * rule: a section the server omitted shows NO status and no card, never a 0.
 */
import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { accessSummaryView, type AccessSummary, type ConnectionCounts } from '../accessSummary.js';

const t = ((raw: string, opts?: Record<string, unknown>) => { const key = raw.replace(/^access-hub:/, ''); return opts ? `${key}${JSON.stringify(opts)}` : key; }) as unknown as TFunction;
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
      connections: { meta: 'meta_issues{"count":1}', metaTone: 'attention' },
      voice: { meta: 'meta_off' },
      mcp: { meta: '0' },
      'api-keys': { meta: '4' },
      orgs: { meta: '1' },
      'capability-firewall': { meta: 'meta_default' },
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
    expect(v.cards[1]).toMatchObject({ value: 3, subTone: 'attention', sub: 'card_connections_issues{"count":1}' });
    expect(v.cards[3]).toMatchObject({ label: 'card_members', value: 6 });
    expect(v.banner?.title).toBe('banner_one_title{"name":"Google Drive"}');
  });

  it('several broken connections → a counted banner', () => {
    const s: AccessSummary = { connections: { workspace: { count: 5, needsReconnect: 2, reconnect: [] }, personal: none } };
    expect(accessSummaryView(s, 'workspace', ALL, t).banner?.title).toBe('banner_many_title{"count":2}');
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
    expect(v.status['api-keys']).toEqual({ meta: 'meta_expired{"count":1}', metaTone: 'attention' });
    expect(v.status['capability-firewall']).toEqual({ meta: 'meta_rules{"count":2}' });
  });
});
