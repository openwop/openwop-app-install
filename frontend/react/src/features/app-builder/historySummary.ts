/**
 * App-builder version-history change summary (ADR 0305 Phase E; structured per
 * ADR 0344 2d). Plugs into the canvas framework's HistoryModal via
 * `CanvasTypeDefinition.summarizeVersions`: kind-tagged entries for screens
 * (added/removed/renamed) and the ADR 0343 application facets (data sources,
 * models, operations, state, auth, environment, references, share policy), plus
 * coarse lines for counts. Entry
 * paths use the validateAppDoc address grammar so diff rows and validator
 * messages share one address space.
 */
import type { VersionDiff, VersionDiffEntry } from '../../canvas/versionSummary.js';
import type { AppDoc } from './screenOps.js';
import type { Screen, CompNode } from './canvasTree.js';

function countComponents(nodes: CompNode[] | undefined): number {
  let n = 0;
  for (const c of nodes ?? []) n += 1 + countComponents(c.children);
  return n;
}

/** The ADR 0343 facets worth a per-facet diff entry (id-bearing arrays). */
const FACETS = ['dataSources', 'models', 'operations', 'stateVariables', 'envRequirements', 'componentDefinitions'] as const;
const OBJECT_FACETS = ['authProfile', 'designSystemRef', 'brandRef', 'sharePolicy'] as const;

export function summarizeChange(snapshot: AppDoc, current: AppDoc, tr: (k: string, o?: Record<string, unknown>) => string): VersionDiff {
  const entries: VersionDiffEntry[] = [];
  const lines: string[] = [];
  const snapScreens = new Map((snapshot.screens ?? []).map((s: Screen) => [s.id, s]));
  const curScreens = new Map((current.screens ?? []).map((s: Screen) => [s.id, s]));
  // Direction: TIMELINE (since this version → now), matching the chassis
  // frames-differ, so "Added" always means "added after this version was
  // captured" (restoring would undo it).
  for (const [id, s] of curScreens) if (!snapScreens.has(id)) entries.push({ path: `screens[${id}]`, kind: 'added', label: tr('histScreenAdded', { name: s.name }) });
  for (const [id, s] of snapScreens) if (!curScreens.has(id)) entries.push({ path: `screens[${id}]`, kind: 'removed', label: tr('histScreenRemoved', { name: s.name }) });
  for (const [id, s] of snapScreens) {
    const cur = curScreens.get(id);
    if (cur && cur.name !== s.name) entries.push({ path: `screens[${id}]`, kind: 'changed', label: tr('histRenamed', { from: s.name, to: cur.name }) });
  }
  // ADR 0343 facets — id-level add/remove/change per facet.
  for (const facet of FACETS) {
    const snapItems = new Map(((snapshot[facet] ?? []) as { id?: string; key?: string }[]).map((m) => [m.id ?? m.key ?? '', m]));
    const curItems = new Map(((current[facet] ?? []) as { id?: string; key?: string }[]).map((m) => [m.id ?? m.key ?? '', m]));
    for (const [id] of curItems) if (id && !snapItems.has(id)) entries.push({ path: `${facet}[${id}]`, kind: 'added', label: tr('histFacetAdded', { facet: tr(`facet_${facet}`), id }) });
    for (const [id] of snapItems) if (id && !curItems.has(id)) entries.push({ path: `${facet}[${id}]`, kind: 'removed', label: tr('histFacetRemoved', { facet: tr(`facet_${facet}`), id }) });
    for (const [id, item] of snapItems) {
      const cur = curItems.get(id);
      if (id && cur && JSON.stringify(item) !== JSON.stringify(cur)) entries.push({ path: `${facet}[${id}]`, kind: 'changed', label: tr('histFacetChanged', { facet: tr(`facet_${facet}`), id }) });
    }
  }
  for (const facet of OBJECT_FACETS) {
    if (JSON.stringify(snapshot[facet] ?? null) !== JSON.stringify(current[facet] ?? null)) {
      entries.push({ path: facet, kind: 'changed', label: tr('histFacetChanged', { facet: tr(`facet_${facet}`), id: '' }) });
    }
  }
  const snapCount = (snapshot.screens ?? []).reduce((acc: number, s: Screen) => acc + countComponents(s.components), 0);
  const curCount = (current.screens ?? []).reduce((acc: number, s: Screen) => acc + countComponents(s.components), 0);
  if (snapCount !== curCount) lines.push(tr('histComponentDelta', { count: snapCount, snapshot: snapCount, current: curCount }));
  if (snapshot.name !== current.name) entries.push({ path: 'name', kind: 'changed', label: tr('histRenamed', { from: snapshot.name, to: current.name }) });
  if (!entries.length && !lines.length) lines.push(tr('histSameStructure'));
  return { lines, entries };
}
