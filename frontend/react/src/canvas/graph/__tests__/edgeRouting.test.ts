/**
 * Pure-geometry proof for the `graph` trait routing (ADR 0323). No DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  portPoint, edgeNormal, autoEdges, straightPath, bezierPath, stepPath, orthogonalPath,
  edgePath, edgeMidpoint, gridLayout, snap, clientToCanvas, contentBounds, fitView, visibleNodeIds, type Box,
} from '../edgeRouting.js';

const box = (x: number, y: number, w = 100, h = 60): Box => ({ x, y, w, h });

describe('portPoint', () => {
  it('is the centre of each edge', () => {
    const b = box(10, 20, 100, 60);
    expect(portPoint(b, 'top')).toEqual({ x: 60, y: 20 });
    expect(portPoint(b, 'bottom')).toEqual({ x: 60, y: 80 });
    expect(portPoint(b, 'left')).toEqual({ x: 10, y: 50 });
    expect(portPoint(b, 'right')).toEqual({ x: 110, y: 50 });
  });
  it('coerces non-finite box fields to 0 (AI-output guard)', () => {
    expect(portPoint({ x: NaN, y: 5, w: Infinity, h: 10 }, 'top')).toEqual({ x: 0, y: 5 });
  });
});

describe('edgeNormal', () => {
  it('points outward from each edge', () => {
    expect(edgeNormal('top')).toEqual({ x: 0, y: -1 });
    expect(edgeNormal('bottom')).toEqual({ x: 0, y: 1 });
    expect(edgeNormal('left')).toEqual({ x: -1, y: 0 });
    expect(edgeNormal('right')).toEqual({ x: 1, y: 0 });
  });
});

describe('autoEdges — pick facing edges by dominant axis', () => {
  it('side-by-side → right/left', () => {
    expect(autoEdges(box(0, 0), box(400, 10))).toEqual({ sourceEdge: 'right', targetEdge: 'left' });
    expect(autoEdges(box(400, 0), box(0, 10))).toEqual({ sourceEdge: 'left', targetEdge: 'right' });
  });
  it('stacked → bottom/top', () => {
    expect(autoEdges(box(0, 0), box(10, 400))).toEqual({ sourceEdge: 'bottom', targetEdge: 'top' });
    expect(autoEdges(box(0, 400), box(10, 0))).toEqual({ sourceEdge: 'top', targetEdge: 'bottom' });
  });
});

describe('path builders emit valid, finite SVG', () => {
  const s = { x: 0, y: 0 }, t = { x: 100, y: 100 };
  it('straight', () => {
    expect(straightPath(s, t)).toBe('M 0 0 L 100 100');
  });
  it('bezier is a cubic that starts at s and ends at t', () => {
    const d = bezierPath(s, t, 'right', 'left');
    expect(d.startsWith('M 0 0 C')).toBe(true);
    expect(d.endsWith('100 100')).toBe(true);
    expect(d).not.toMatch(/NaN|Infinity/);
  });
  it('step makes right angles (two mid vertices)', () => {
    const d = stepPath({ x: 0, y: 0 }, { x: 100, y: 40 }, 'right');
    expect(d).toBe('M 0 0 L 50 0 L 50 40 L 100 40');
  });
  it('orthogonal stubs off each port then bridges', () => {
    const d = orthogonalPath({ x: 0, y: 0 }, { x: 200, y: 0 }, 'right', 'left');
    expect(d.split('L').length).toBeGreaterThanOrEqual(4); // multiple segments
    expect(d).not.toMatch(/NaN/);
  });
});

describe('edgePath — dispatch + auto edges', () => {
  it('defaults to bezier with auto edges', () => {
    expect(edgePath(box(0, 0), box(400, 0)).startsWith('M')).toBe(true);
  });
  it('honours explicit edges + routing', () => {
    const d = edgePath(box(0, 0, 100, 60), box(0, 400, 100, 60), { sourceEdge: 'bottom', targetEdge: 'top', routing: 'straight' });
    expect(d).toBe('M 50 60 L 50 400');
  });
  it('is NaN-safe for garbage boxes', () => {
    const d = edgePath({ x: NaN, y: NaN, w: NaN, h: NaN }, box(10, 10), { routing: 'bezier' });
    expect(d).not.toMatch(/NaN|Infinity/);
  });
});

describe('edgeMidpoint', () => {
  it('is the mean of the two facing ports', () => {
    expect(edgeMidpoint(box(0, 0, 100, 60), box(400, 0, 100, 60))).toEqual({ x: 250, y: 30 });
  });
});

describe('gridLayout', () => {
  it('places N nodes in a √N grid, input order stable', () => {
    const m = gridLayout(['a', 'b', 'c', 'd'], { w: 100, h: 100, gap: 20, originX: 0, originY: 0 });
    expect(m.get('a')).toEqual({ x: 0, y: 0 });
    expect(m.get('b')).toEqual({ x: 120, y: 0 });
    expect(m.get('c')).toEqual({ x: 0, y: 120 });
    expect(m.get('d')).toEqual({ x: 120, y: 120 });
  });
  it('handles a single node', () => {
    expect(gridLayout(['solo'], { w: 100, h: 100, originX: 10, originY: 10 }).get('solo')).toEqual({ x: 10, y: 10 });
  });
});

describe('snap + clientToCanvas', () => {
  it('snaps to the grid (0 = off)', () => {
    expect(snap(13, 10)).toBe(10);
    expect(snap(16, 10)).toBe(20);
    expect(snap(13, 0)).toBe(13);
  });
  it('converts a client point to canvas coords through pan/zoom', () => {
    // rect at (100,50); pan (20,10); zoom 2 → canvas = ((cx-100-20)/2, (cy-50-10)/2)
    expect(clientToCanvas(320, 250, { left: 100, top: 50 }, { x: 20, y: 10 }, 2)).toEqual({ x: 100, y: 95 });
  });
  it('treats zoom<=0 as 1', () => {
    expect(clientToCanvas(100, 100, { left: 0, top: 0 }, { x: 0, y: 0 }, 0)).toEqual({ x: 100, y: 100 });
  });
});

describe('contentBounds + fitView', () => {
  it('bounds wrap all boxes; null for empty', () => {
    expect(contentBounds([box(10, 20, 100, 60), box(200, 0, 50, 50)])).toEqual({ minX: 10, minY: 0, maxX: 250, maxY: 80 });
    expect(contentBounds([])).toBeNull();
  });
  it('fitView centres content and clamps zoom to ≤1 for small content', () => {
    // 100×100 content in a 1000×1000 viewport → would zoom >1, clamped to 1; centred.
    const { pan, zoom } = fitView({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 1000, 1000, 40);
    expect(zoom).toBe(1);
    expect(pan).toEqual({ x: 450, y: 450 }); // (1000 - 100)/2
  });
  it('fitView zooms OUT to frame large content (never below 0.25)', () => {
    const { zoom } = fitView({ minX: 0, minY: 0, maxX: 4000, maxY: 3000 }, 800, 600, 40);
    expect(zoom).toBeGreaterThanOrEqual(0.25);
    expect(zoom).toBeLessThan(1);
  });
  it('fitView floors zoom at 0.25 for enormous content', () => {
    expect(fitView({ minX: 0, minY: 0, maxX: 100000, maxY: 100000 }, 800, 600).zoom).toBe(0.25);
  });
});

describe('visibleNodeIds — the virtualization cull (audit polish P3)', () => {
  const m = new Map<string, Box>([
    ['a', box(0, 0)],          // in view
    ['b', box(2000, 0)],       // right of view (beyond margin)
    ['c', box(700, 0)],        // outside but within the 400 margin
    ['d', box(0, 5000)],       // far below
  ]);
  it('keeps boxes intersecting the pan/zoomed viewport (+margin)', () => {
    const v = visibleNodeIds(m, { x: 0, y: 0 }, 1, 600, 400);
    expect(v.has('a')).toBe(true);
    expect(v.has('c')).toBe(true);  // margin catch
    expect(v.has('b')).toBe(false);
    expect(v.has('d')).toBe(false);
  });
  it('pan brings far nodes into view', () => {
    const v = visibleNodeIds(m, { x: -1600, y: 0 }, 1, 600, 400);
    expect(v.has('b')).toBe(true);
    expect(v.has('a')).toBe(false); // scrolled past (0+100 < 1600-400)
  });
  it('zooming out widens the visible canvas rect', () => {
    const v = visibleNodeIds(m, { x: 0, y: 0 }, 0.25, 600, 400);
    expect(v.has('b')).toBe(true); // 600/0.25 = 2400 canvas units wide
  });
});
