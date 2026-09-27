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

const labels = (d: ReturnType<typeof summarizeChange>): string[] => (d.entries ?? []).map((e) => e.label);
const kinds = (d: ReturnType<typeof summarizeChange>): Record<string, string> =>
  Object.fromEntries((d.entries ?? []).map((e) => [e.path, e.kind]));

describe('summarizeChange (structured, timeline direction)', () => {
  it('reports screen add/remove/rename with kinds + addressable paths', () => {
    const snap = doc([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
    const cur = doc([{ id: 'b', name: 'Beta 2' }, { id: 'c', name: 'Gamma' }]);
    const d = summarizeChange(snap, cur, t);
    expect(labels(d)).toContain('histScreenAdded:Gamma');      // in current, not this version
    expect(labels(d)).toContain('histScreenRemoved:Alpha');    // in this version, gone now
    expect(labels(d)).toContain('histRenamed:Beta,Beta 2');
    expect(kinds(d)['screens[c]']).toBe('added');
    expect(kinds(d)['screens[a]']).toBe('removed');
    expect(kinds(d)['screens[b]']).toBe('changed');
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
    const k = kinds(summarizeChange(snap, cur, t));
    expect(k['models[task]']).toBe('changed');
    expect(k['operations[listTasks]']).toBe('added');
    expect(k['dataSources[customers]']).toBe('changed');
    expect(k['envRequirements[API_URL]']).toBe('removed');
    expect(k['authProfile']).toBe('changed');
    expect(k['designSystemRef']).toBe('changed');
    expect(k['sharePolicy']).toBe('changed');
  });
  it('reports component-count delta as a line and app rename as an entry', () => {
    const snap = doc([{ id: 'a', name: 'A', components: [{ type: 'stack', children: [{ type: 'text' }] }] }], 'Old');
    const cur = doc([{ id: 'a', name: 'A', components: [{ type: 'text' }] }], 'New');
    const d = summarizeChange(snap, cur, t);
    expect(d.lines).toContain('histComponentDelta:2,2,1');
    expect(labels(d)).toContain('histRenamed:Old,New');
  });
  it('says same-structure when nothing differs', () => {
    const d = doc([{ id: 'a', name: 'A', components: [{ type: 'text' }] }]);
    const out = summarizeChange(d, JSON.parse(JSON.stringify(d)) as AppDoc, t);
    expect(out.lines).toEqual(['histSameStructure']);
    expect(out.entries).toEqual([]);
  });
});
