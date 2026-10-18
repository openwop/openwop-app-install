/**
 * ADR 0305 Phase E → ADR 0344 2d — the client-side change summary shown per
 * history row, now a STRUCTURED VersionDiff with timeline-direction entries
 * (added/removed = since this version) covering screens AND the ADR 0343
 * application facets.
 */
import { describe, it, expect } from 'vitest';
import { summarizeChange } from '../historySummary.js';
import type { AppDoc } from '../screenOps.js';

const t = (k: string, o?: Record<string, unknown>): string => `${k}${o ? ':' + Object.values(o).join(',') : ''}`;

const doc = (screens: AppDoc['screens'], name = 'App', extra: Partial<AppDoc> = {}): AppDoc => ({ name, screens, ...extra });

const kinds = (d: ReturnType<typeof summarizeChange>): Record<string, string> =>
  Object.fromEntries((d.entries ?? []).map((e) => [e.path, e.kind]));

describe('summarizeChange (structured, timeline direction)', () => {
  it('reports screen add/remove/rename with kinds + addressable paths', () => {
    const snap = doc([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
    const cur = doc([{ id: 'b', name: 'Beta 2' }, { id: 'c', name: 'Gamma' }]);
    const d = summarizeChange(snap, cur, t);
    expect(d.entries).toEqual([
      { path: 'screens[c]', kind: 'added', label: 'histScreenAdded:Gamma' },      // in current, not this version
      { path: 'screens[a]', kind: 'removed', label: 'histScreenRemoved:Alpha' },  // in this version, gone now
      { path: 'screens[b]', kind: 'changed', label: 'histRenamed:Beta,Beta 2' },
    ]);
    expect(d.lines).toEqual([]);
  });
  it('diffs the ADR 0343 facets by id and records app-contract object facets', () => {
    const snap = doc([{ id: 'a', name: 'A' }], 'App', {
      models: [{ id: 'task', name: 'Task', fields: [{ name: 'x', type: 'string' }] }],
      dataSources: [{ id: 'customers', name: 'Customers' }],
      envRequirements: [{ key: 'API_URL', purpose: 'p' }],
      authProfile: { kind: 'none' },
      designSystemRef: { id: 'ds_old' },
      sharePolicy: { sampleData: 'redact' },
    });
    const cur = doc([{ id: 'a', name: 'A' }], 'App', {
      models: [{ id: 'task', name: 'Task RENAMED', fields: [{ name: 'x', type: 'string' }] }],
      operations: [{ id: 'listTasks', name: 'List', kind: 'list' }],
      dataSources: [{ id: 'customers', name: 'Customers v2' }],
      authProfile: { kind: 'sso' },
      designSystemRef: { id: 'ds_new', mode: 'linked' },
      sharePolicy: { sampleData: 'include' },
    });
    // Exact map: an unchanged facet (brandRef, stateVariables…) must NOT appear.
    expect(kinds(summarizeChange(snap, cur, t))).toEqual({
      'models[task]': 'changed',
      'operations[listTasks]': 'added',
      'dataSources[customers]': 'changed',
      'envRequirements[API_URL]': 'removed',
      authProfile: 'changed',
      designSystemRef: 'changed',
      sharePolicy: 'changed',
    });
  });
  it('reports component-count delta as a line and app rename as an entry', () => {
    const snap = doc([{ id: 'a', name: 'A', components: [{ type: 'stack', children: [{ type: 'text' }] }] }], 'Old');
    const cur = doc([{ id: 'a', name: 'A', components: [{ type: 'text' }] }], 'New');
    const d = summarizeChange(snap, cur, t);
    expect(d.lines).toEqual(['histComponentDelta:2,2,1']);
    expect(d.entries).toEqual([{ path: 'name', kind: 'changed', label: 'histRenamed:Old,New' }]);
  });
  it('says same-structure when nothing differs', () => {
    const d = doc([{ id: 'a', name: 'A', components: [{ type: 'text' }] }]);
    const out = summarizeChange(d, JSON.parse(JSON.stringify(d)) as AppDoc, t);
    expect(out.lines).toEqual(['histSameStructure']);
    expect(out.entries).toEqual([]);
  });
});
