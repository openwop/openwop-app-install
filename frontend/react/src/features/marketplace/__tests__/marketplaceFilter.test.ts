import { describe, it, expect } from 'vitest';
import type { Listing } from '../marketplaceClient';
import {
  domainOf, statusOf, deriveFacets, applyFilters, anyFilterActive, EMPTY_FILTERS,
} from '../marketplaceFilter';

const L = (p: Partial<Listing> & Pick<Listing, 'packName' | 'category'>): Listing => ({
  version: '1.0.0', title: p.packName, installed: false, ...p,
} as Listing);

const CATALOG: Listing[] = [
  L({ packName: 'feature.crm.nodes', category: 'Node pack', author: 'openwop-team', installed: true }),
  L({ packName: 'feature.crm.agents', category: 'Skill', author: 'openwop-team' }),
  L({ packName: 'feature.commerce.nodes', category: 'Node pack', author: 'acme', installed: true }),
  L({ packName: 'core.openwop.agents.code-reviewer', category: 'Skill', author: 'openwop-team' }),
  L({ packName: 'feature.legacy.nodes', category: 'Node pack', author: 'acme', tombstoned: true }),
];

describe('domainOf', () => {
  it('takes the namespace segment as the category', () => {
    expect(domainOf('feature.crm.nodes')).toBe('crm');
    expect(domainOf('core.openwop.agents.code-reviewer')).toBe('openwop');
  });
  it('falls back to the whole name for a single segment', () => {
    expect(domainOf('solo')).toBe('solo');
  });
});

describe('statusOf', () => {
  it('maps tombstoned → removed, installed → installed, else available', () => {
    expect(statusOf(L({ packName: 'a.b.c', category: 'x', tombstoned: true, installed: true }))).toBe('removed');
    expect(statusOf(L({ packName: 'a.b.c', category: 'x', installed: true }))).toBe('installed');
    expect(statusOf(L({ packName: 'a.b.c', category: 'x' }))).toBe('available');
  });
});

describe('deriveFacets', () => {
  it('returns unique, sorted facet values (statuses only those present)', () => {
    const f = deriveFacets(CATALOG);
    expect(f.types).toEqual(['Node pack', 'Skill']);
    expect(f.domains).toEqual(['commerce', 'crm', 'legacy', 'openwop']);
    expect(f.vendors).toEqual(['acme', 'openwop-team']);
    expect(f.statuses.sort()).toEqual(['available', 'installed', 'removed']);
  });
  it('drops empty vendors', () => {
    const f = deriveFacets([L({ packName: 'a.b.c', category: 'x' })]);
    expect(f.vendors).toEqual([]);
  });
});

describe('applyFilters', () => {
  it('no filters returns the whole catalog', () => {
    expect(applyFilters(CATALOG, EMPTY_FILTERS)).toHaveLength(CATALOG.length);
  });
  it('filters by type, category (domain), vendor and status — composing (AND)', () => {
    expect(applyFilters(CATALOG, { ...EMPTY_FILTERS, type: 'Node pack' })).toHaveLength(3);
    expect(applyFilters(CATALOG, { ...EMPTY_FILTERS, domain: 'crm' })).toHaveLength(2);
    expect(applyFilters(CATALOG, { ...EMPTY_FILTERS, vendor: 'acme' })).toHaveLength(2);
    expect(applyFilters(CATALOG, { ...EMPTY_FILTERS, status: 'installed' })).toHaveLength(2);
    // AND: node packs from acme that are installed → only feature.commerce.nodes
    const combined = applyFilters(CATALOG, { ...EMPTY_FILTERS, type: 'Node pack', vendor: 'acme', status: 'installed' });
    expect(combined.map((l) => l.packName)).toEqual(['feature.commerce.nodes']);
  });
  it('search matches packName, title, description AND author', () => {
    expect(applyFilters(CATALOG, { ...EMPTY_FILTERS, query: 'commerce' }).map((l) => l.packName)).toEqual(['feature.commerce.nodes']);
    // author-only match (the term appears in no name/title)
    expect(applyFilters(CATALOG, { ...EMPTY_FILTERS, query: 'acme' })).toHaveLength(2);
  });
});

describe('anyFilterActive', () => {
  it('is false only when every facet + search is empty', () => {
    expect(anyFilterActive(EMPTY_FILTERS)).toBe(false);
    expect(anyFilterActive({ ...EMPTY_FILTERS, status: 'installed' })).toBe(true);
    expect(anyFilterActive({ ...EMPTY_FILTERS, query: 'x' })).toBe(true);
  });
});
