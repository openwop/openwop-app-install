/**
 * The app-builder `graph` trait (ADR 0323 Phase 2) — projection + mutations.
 * Pure logic (no DOM): the chassis owns the interactive surface; this proves the
 * doc↔nodes/edges mapping and the clone-mutating helpers the chassis commits.
 */
import { describe, it, expect } from 'vitest';
import { appBuilderGraph } from '../appBuilderGraph.js';
import type { AppDoc } from '../screenOps.js';

const doc = (): AppDoc => ({
  name: 'App',
  theme: 'dark',
  themeColors: { primary: '#7c5cff' },
  screens: [
    { id: 'home', name: 'Home', isInitial: true, x: 10, y: 20, components: [{ type: 'button' }] },
    { id: 'next', name: 'Next', components: [] },
  ],
  connectors: [{ from: 'home', to: 'next', trigger: 'click', routingStyle: 'bezier', animated: true, label: 'Go' }],
  dataSources: [{ id: 'rows', name: 'Rows', rows: [{ a: 1 }] }],
});

describe('appBuilderGraph — projection', () => {
  it('projects screens → nodes (position, home badge, payload)', () => {
    const nodes = appBuilderGraph.nodes(doc());
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ id: 'home', label: 'Home', x: 10, y: 20, isHome: true });
    expect((nodes[0]!.data as { theme?: string }).theme).toBe('dark');
    expect((nodes[0]!.data as { screen: { id: string } }).screen.id).toBe('home');
    // ADR 0342 Phase 0: board nodes carry the generated theme + sample data —
    // the node preview must render the SAME doc the full preview does.
    expect((nodes[0]!.data as AppDoc).themeColors).toEqual({ primary: '#7c5cff' });
    expect((nodes[0]!.data as AppDoc).dataSources).toEqual([{ id: 'rows', name: 'Rows', rows: [{ a: 1 }] }]);
    // an un-placed screen carries no x/y/isHome (auto-layout + no badge)
    expect(nodes[1]).toEqual({ id: 'next', label: 'Next', data: expect.anything() });
  });

  it('projects connectors → edges (index-as-id + presentation)', () => {
    const edges = appBuilderGraph.edges(doc());
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ id: '0', from: 'home', to: 'next', routing: 'bezier', animated: true, label: 'Go' });
    expect((edges[0]!.data as { from: string }).from).toBe('home'); // the raw connector rides along

  });
});

describe('appBuilderGraph — mutations (clone-mutating; chassis commits)', () => {
  it('moveNode sets a rounded position', () => {
    const d = doc();
    appBuilderGraph.moveNode(d, 'home', 33.6, 40.2);
    expect(d.screens[0]).toMatchObject({ x: 34, y: 40 });
  });

  it('connect rejects self / missing / duplicate, accepts a new edge', () => {
    const d = doc();
    expect(appBuilderGraph.connect(d, 'home', 'home')).toBe(false); // self
    expect(appBuilderGraph.connect(d, 'home', 'ghost')).toBe(false); // missing target
    expect(appBuilderGraph.connect(d, 'home', 'next')).toBe(false); // duplicate
    expect(d.connectors).toHaveLength(1);
    expect(appBuilderGraph.connect(d, 'next', 'home')).toBe(true);
    expect(d.connectors).toHaveLength(2);
    expect(d.connectors![1]).toEqual({ from: 'next', to: 'home' });
  });

  it('connect bootstraps the connectors array when absent', () => {
    const d: AppDoc = { name: 'A', screens: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
    expect(appBuilderGraph.connect(d, 'a', 'b')).toBe(true);
    expect(d.connectors).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('deleteEdge splices by index; out-of-range is a no-op', () => {
    const d = doc();
    appBuilderGraph.deleteEdge(d, '5');
    expect(d.connectors).toHaveLength(1);
    appBuilderGraph.deleteEdge(d, '0');
    expect(d.connectors).toHaveLength(0);
  });
});

describe('appBuilderGraph — edge property editing (audit gap #1)', () => {
  it('edges carry the raw connector as data + edgePropDefs cover the closed-world fields', () => {
    const edges = appBuilderGraph.edges(doc());
    expect((edges[0]!.data as { trigger?: string }).trigger).toBe('click');
    const names = (appBuilderGraph.edgePropDefs ?? []).map((p) => p.name);
    expect(names).toEqual(['label', 'trigger', 'transition', 'routingStyle', 'animated']);
  });
  it('updateEdge merges values and DELETES cleared (undefined/empty) keys', () => {
    const d = doc();
    appBuilderGraph.updateEdge!(d, '0', { transition: 'modal', label: undefined, animated: '' });
    expect(d.connectors![0]).toEqual({ from: 'home', to: 'next', trigger: 'click', routingStyle: 'bezier', transition: 'modal' });
  });
  it('updateEdge is a no-op for an out-of-range id', () => {
    const d = doc();
    appBuilderGraph.updateEdge!(d, '9', { label: 'x' });
    expect(d.connectors![0]!.label).toBe('Go');
  });
});

describe('appBuilderGraph — addConnectedNode (audit gap #2)', () => {
  it('creates a screen beside the source + an auto-connector, returning the new id', () => {
    const d = doc();
    const id = appBuilderGraph.addConnectedNode!(d, 'home', 'Screen 3');
    expect(id).toBeTruthy();
    const created = d.screens.find((s) => s.id === id)!;
    expect(created.name).toBe('Screen 3');
    expect(created.x).toBe(10 + 190 + 120); // source.x + NODE_W + SPAWN_GAP
    expect(created.y).toBe(20);
    expect(d.connectors!.some((c) => c.from === 'home' && c.to === id)).toBe(true);
  });
  it('returns null for a missing source or at the screen cap', () => {
    expect(appBuilderGraph.addConnectedNode!(doc(), 'ghost', 'X')).toBeNull();
    const full = doc();
    while (full.screens.length < 60) full.screens.push({ id: `s${full.screens.length}`, name: 'S' });
    expect(appBuilderGraph.addConnectedNode!(full, 'home', 'X')).toBeNull();
  });
  it('§7.4/CV-10 link-drag-create: a drop position lands the screen there, grid-snapped', () => {
    const d = doc();
    const id = appBuilderGraph.addConnectedNode!(d, 'home', 'Dropped', { x: 333, y: 287 });
    const created = d.screens.find((sc) => sc.id === id);
    expect(created?.x).toBe(340); // 333 → snapped to the 20px grid
    expect(created?.y).toBe(280);
    expect(d.connectors?.some((c) => c.from === 'home' && c.to === id)).toBe(true);
  });
  it('without a position the offset placement is unchanged (keyboard/button path)', () => {
    const d = doc();
    const from = d.screens.find((sc) => sc.id === 'home');
    const id = appBuilderGraph.addConnectedNode!(d, 'home', 'Offset');
    const created = d.screens.find((sc) => sc.id === id);
    expect(created?.x).toBe(((from?.x as number) ?? 80) + 190 + 120);
  });
});

describe('appBuilderGraph — renderNode', () => {
  it('renders a screen body when the node carries a payload, null otherwise', () => {
    const nodes = appBuilderGraph.nodes(doc());
    expect(appBuilderGraph.renderNode(nodes[0]!, { selected: false })).toBeTruthy();
    expect(appBuilderGraph.renderNode({ id: 'x', label: 'X' }, { selected: false })).toBeNull();
  });
});
