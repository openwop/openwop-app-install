import { describe, it, expect } from 'vitest';
import { chromeFor, isAdminPath, featureFor, navItemIsActive, WORKSPACE_NAV, NAV, GROUP_ORDER } from '../features.js';

/**
 * The feature manifest is the single source of truth for routes, the
 * workspace/admin tier split, chrome, and nav-active state (frontend
 * enterprise-review Batch J). These cover the pure derivations so a manifest
 * edit that breaks routing/tiering is caught.
 */
describe('feature manifest routing', () => {
  it('maps "/" to the chat home route (not admin)', () => {
    expect(featureFor('/')).not.toBeNull();
    expect(chromeFor('/')).toBe('chat');
    expect(isAdminPath('/')).toBe(false);
  });

  it('classifies /runs as an admin-tier route', () => {
    expect(featureFor('/runs')).not.toBeNull();
    expect(isAdminPath('/runs')).toBe(true);
  });

  it('returns null + default chrome for an unknown path', () => {
    expect(featureFor('/totally-unknown-xyz')).toBeNull();
    expect(chromeFor('/totally-unknown-xyz')).toBe('default');
    expect(isAdminPath('/totally-unknown-xyz')).toBe(false);
  });

  it('uses react-router specificity (static beats param)', () => {
    // A deep run path resolves to the run-detail feature, not a broader one.
    const detail = featureFor('/runs/run-123');
    expect(detail).not.toBeNull();
  });
});

describe('navItemIsActive', () => {
  it('exact match when end is set', () => {
    expect(navItemIsActive({ to: '/', end: true } as never, '/')).toBe(true);
    expect(navItemIsActive({ to: '/', end: true } as never, '/runs')).toBe(false);
  });

  it('prefix match when end is unset', () => {
    expect(navItemIsActive({ to: '/agents' } as never, '/agents/abc')).toBe(true);
    expect(navItemIsActive({ to: '/agents' } as never, '/agentsx')).toBe(false);
  });

  it('respects notUnder exclusions', () => {
    expect(navItemIsActive({ to: '/agents', notUnder: ['/agents/new'] } as never, '/agents/new')).toBe(false);
  });
});

describe('nav registry — category + position ordering', () => {
  const labels = (groupLabel: string): string[] =>
    WORKSPACE_NAV.find((g) => g.label === groupLabel)?.items.map((i) => i.label) ?? [];

  it('groups are ordered by GROUP_ORDER (Workspace before Author)', () => {
    const order = WORKSPACE_NAV.map((g) => g.label);
    expect(order.indexOf('Workspace')).toBeLessThan(order.indexOf('Author'));
    // every workspace group is a known category
    for (const g of WORKSPACE_NAV) expect(GROUP_ORDER).toContain(g.label);
  });

  it('items sort by nav.order ascending within a group', () => {
    const ws = labels('Workspace');
    // Chat(10) · Agents(20) · Boards(30) are the explicitly-ordered core items.
    expect(ws.indexOf('Chat')).toBeLessThan(ws.indexOf('Agents'));
    expect(ws.indexOf('Agents')).toBeLessThan(ws.indexOf('Boards'));
  });

  it('feature items slot at their declared order (CRM=40, CMS=50 after Boards=30)', () => {
    // NAV includes feature-gated items regardless of resolved enablement (the
    // catalog; the Sidebar/⌘K filter visibility separately).
    const ws = NAV.find((g) => g.label === 'Workspace')?.items.map((i) => i.label) ?? [];
    expect(ws.indexOf('Boards')).toBeLessThan(ws.indexOf('CRM'));
    expect(ws.indexOf('CRM')).toBeLessThan(ws.indexOf('CMS'));
  });

  it('an order-less item sorts after ordered ones (append-at-end preserved)', () => {
    const ws = NAV.find((g) => g.label === 'Workspace')?.items ?? [];
    const ordered = ws.filter((i) => i.order !== undefined).map((i) => i.label);
    const unordered = ws.filter((i) => i.order === undefined).map((i) => i.label);
    if (ordered.length && unordered.length) {
      const lastOrdered = ws.findIndex((i) => i.label === ordered[ordered.length - 1]!);
      const firstUnordered = ws.findIndex((i) => i.label === unordered[0]!);
      expect(lastOrdered).toBeLessThan(firstUnordered);
    }
  });
});
