/** §4.5 filtering on /feature-toggles — the pure client filter behind the
 *  key-figure tiles (status/attention) + the filterbar (search/category/sort). */
import { describe, it, expect } from 'vitest';
import { filterToggles, sortToggles } from '../FeatureTogglePanel.js';
import type { ToggleConfig } from '../../client/featureTogglesClient.js';

const GENERAL = 'General';
const cfg = (over: Partial<ToggleConfig> & { id: string }): ToggleConfig =>
  ({ status: 'on', bucketUnit: 'user', ...over }) as ToggleConfig;

const CONFIGS: ToggleConfig[] = [
  cfg({ id: 'crm', label: 'CRM', status: 'on', category: 'Sales' }),
  cfg({ id: 'app-builder', label: 'App Builder', status: 'beta', category: 'Studio', description: 'Design and export apps' }),
  cfg({ id: 'code-export', label: 'Code Export', status: 'off', category: 'Studio' }),
  cfg({ id: 'inbox', label: 'Inbox', status: 'on' }), // no category → General
];

const none = { status: null, query: '', category: '' } as const;

describe('filterToggles', () => {
  it('no filters → everything, in order', () => {
    expect(filterToggles(CONFIGS, { ...none }, new Set(), GENERAL).map((c) => c.id))
      .toEqual(['crm', 'app-builder', 'code-export', 'inbox']);
  });

  it('status tiles narrow to that stored status', () => {
    expect(filterToggles(CONFIGS, { ...none, status: 'beta' }, new Set(), GENERAL).map((c) => c.id)).toEqual(['app-builder']);
    expect(filterToggles(CONFIGS, { ...none, status: 'on' }, new Set(), GENERAL).map((c) => c.id)).toEqual(['crm', 'inbox']);
  });

  it('the attention tile filters by the derived set, not stored status', () => {
    const attention = new Set(['code-export', 'inbox']);
    expect(filterToggles(CONFIGS, { ...none, status: 'attention' }, attention, GENERAL).map((c) => c.id))
      .toEqual(['code-export', 'inbox']);
  });

  it('search matches id, label, and description, case-insensitively', () => {
    expect(filterToggles(CONFIGS, { ...none, query: 'BUILDER' }, new Set(), GENERAL).map((c) => c.id)).toEqual(['app-builder']);
    expect(filterToggles(CONFIGS, { ...none, query: 'export apps' }, new Set(), GENERAL).map((c) => c.id)).toEqual(['app-builder']);
    expect(filterToggles(CONFIGS, { ...none, query: '  crm ' }, new Set(), GENERAL).map((c) => c.id)).toEqual(['crm']);
  });

  it('category select narrows, with the General fallback bucket', () => {
    expect(filterToggles(CONFIGS, { ...none, category: 'Studio' }, new Set(), GENERAL).map((c) => c.id))
      .toEqual(['app-builder', 'code-export']);
    expect(filterToggles(CONFIGS, { ...none, category: GENERAL }, new Set(), GENERAL).map((c) => c.id)).toEqual(['inbox']);
  });

  it('filters compose (AND)', () => {
    expect(filterToggles(CONFIGS, { status: 'off', query: 'export', category: 'Studio' }, new Set(), GENERAL).map((c) => c.id))
      .toEqual(['code-export']);
    expect(filterToggles(CONFIGS, { status: 'on', query: 'export', category: '' }, new Set(), GENERAL)).toEqual([]);
  });
});

describe('sortToggles', () => {
  const items: ToggleConfig[] = [
    cfg({ id: 'b', label: 'Bravo', updatedAt: '2026-07-01T00:00:00Z' }),
    cfg({ id: 'a', label: 'alpha', updatedAt: '2026-07-10T00:00:00Z' }),
    cfg({ id: 'c', label: 'Charlie' }), // undated
  ];

  it("'default' keeps the load order (and returns the same array)", () => {
    expect(sortToggles(items, 'default').map((c) => c.id)).toEqual(['b', 'a', 'c']);
  });

  it("'name' sorts locale-aware A–Z by label, without mutating the input", () => {
    expect(sortToggles(items, 'name').map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(items.map((c) => c.id)).toEqual(['b', 'a', 'c']);
  });

  it("'updated' is most-recent first; undated rows sink", () => {
    expect(sortToggles(items, 'updated').map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });
});
