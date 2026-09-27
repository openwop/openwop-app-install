/**
 * DRAW-R4/DATA-D9 — pins the FE drawings bound tables against the backend
 * authority (NUM_FIELDS / STR_FIELDS / doc dims in
 * backend/typescript/src/features/drawings/validateDrawingDoc.ts). The FE and BE
 * live in separate packages, so this is the FE half of a cross-package
 * dual-mirror: if a backend bound changes, THIS test's expected values must
 * change too (and vice-versa). A drift here means panel edits either 422 or
 * over-constrain — cheap to catch, annoying to ship.
 */
import { describe, expect, it } from 'vitest';
import { drawingsDefinition, NUM_BOUNDS, STR_BOUNDS } from '../definition.js';
import type { CanvasPropDef } from '../../../canvas/types.js';

describe('drawings bound tables mirror validateDrawingDoc', () => {
  it('NUM_BOUNDS matches the backend NUM_FIELDS min/max', () => {
    expect(NUM_BOUNDS.fontSize).toMatchObject({ min: 1, max: 400 });
    expect(NUM_BOUNDS.strokeWidth).toMatchObject({ min: 0, max: 100 });
    expect(NUM_BOUNDS.opacity).toMatchObject({ min: 0, max: 1 });
    expect(NUM_BOUNDS.size).toMatchObject({ min: 0.5, max: 100 });
    expect(NUM_BOUNDS.taperStart).toMatchObject({ min: 0, max: 4000 });
    expect(NUM_BOUNDS.taperEnd).toMatchObject({ min: 0, max: 4000 });
    for (const f of ['width', 'height', 'rx', 'ry', 'r'] as const) expect(NUM_BOUNDS[f]).toEqual({ min: 0 });
    for (const f of ['x', 'y', 'cx', 'cy', 'x1', 'y1', 'x2', 'y2', 'rotation'] as const) expect(NUM_BOUNDS[f]).toEqual({});
  });

  it('STR_BOUNDS matches the backend STR_FIELDS maxLengths', () => {
    expect(STR_BOUNDS).toEqual({ text: 400, fill: 40, stroke: 40, color: 40, name: 80, groupId: 40 });
  });
});

describe('drawings propDefs surface the bounds', () => {
  const find = (defs: CanvasPropDef[], name: string): CanvasPropDef | undefined => defs.find((d) => d.name === name);
  const shapeDefs = (kind: string): CanvasPropDef[] => drawingsDefinition.elements![0]!.propDefs({ kind });

  it('a rect surfaces the strokeWidth/opacity bounds', () => {
    expect(find(shapeDefs('rect'), 'strokeWidth')).toMatchObject({ min: 0, max: 100 });
    expect(find(shapeDefs('rect'), 'opacity')).toMatchObject({ min: 0, max: 1 });
  });

  it('a stroke surfaces the size bound + step', () => {
    expect(find(shapeDefs('stroke'), 'size')).toMatchObject({ min: 0.5, max: 100, step: 0.5 });
  });

  it('a text surfaces the fontSize bound and text maxLength', () => {
    expect(find(shapeDefs('text'), 'fontSize')).toMatchObject({ min: 1, max: 400 });
    expect(find(shapeDefs('text'), 'text')).toMatchObject({ maxLength: 400 });
  });

  it('the DOC dims carry the [1,4000] / [1,500] bounds (distinct from element width/height)', () => {
    const docDefs = drawingsDefinition.docPropDefs!;
    expect(find(docDefs, 'width')).toMatchObject({ min: 1, max: 4000 });
    expect(find(docDefs, 'height')).toMatchObject({ min: 1, max: 4000 });
    expect(find(docDefs, 'gridSize')).toMatchObject({ min: 1, max: 500 });
  });
});
