/**
 * ADR 0360 — campaign funnel board trait: order-derived chain, positional
 * node ids, clamped/snapped moves, and the elements-selection bridge.
 */
import { describe, it, expect } from 'vitest';
import { campaignGraph } from '../campaignGraph.js';
import type { CampaignDoc } from '../definition.js';

const doc = (): CampaignDoc => ({
  name: 'Launch',
  channels: [{ name: 'Email', type: 'email' }],
  funnel: [
    { stage: 'awareness', x: 100, y: 100 },
    { stage: 'consideration' },
    { stage: 'conversion', kpis: ['CVR'] },
  ],
} as unknown as CampaignDoc);

describe('campaignGraph (ADR 0360)', () => {
  it('projects funnel stages as positional nodes; unpositioned stages omit x/y (auto-grid)', () => {
    const nodes = campaignGraph.nodes(doc());
    expect(nodes.map((n) => n.id)).toEqual(['funnel-0', 'funnel-1', 'funnel-2']);
    expect(nodes[0]).toMatchObject({ x: 100, y: 100 });
    expect(nodes[1]?.x).toBeUndefined();
  });

  it('the chain derives from array order — n-1 edges, no storage', () => {
    const edges = campaignGraph.edges(doc());
    expect(edges).toEqual([
      { id: 'chain-0', from: 'funnel-0', to: 'funnel-1' },
      { id: 'chain-1', from: 'funnel-1', to: 'funnel-2' },
    ]);
  });

  it('moveNode writes clamped, grid-snapped positions onto the stage', () => {
    const d = doc();
    campaignGraph.moveNode(d, 'funnel-1', 333, 4500);
    expect(d.funnel?.[1]).toMatchObject({ x: 340, y: 4000 });
    // Unknown/garbage ids are a no-op, never a throw.
    campaignGraph.moveNode(d, 'chain-0', 1, 1);
    campaignGraph.moveNode(d, 'funnel-99', 1, 1);
  });

  it('connect/deleteEdge are OMITTED — derived edges render no connect chrome (grade-pass ruling)', () => {
    expect(campaignGraph.connect).toBeUndefined();
    expect(campaignGraph.deleteEdge).toBeUndefined();
  });

  it('elementForNode bridges board selection to the funnel elements selection', () => {
    expect(campaignGraph.elementForNode?.('funnel-2')).toEqual({ col: 'funnel', idx: 2 });
    expect(campaignGraph.elementForNode?.('chain-0')).toBeNull();
  });

  it('opens board-first', () => {
    expect(campaignGraph.defaultView).toBe('graph');
  });
});
