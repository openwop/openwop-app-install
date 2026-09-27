/**
 * Drawings canvas (ADR 0153 Phase 4) — the host-side contract: `canvas.drawing` is a
 * registered artifact type whose schema gates `artifact.created` (ADR 0055). A valid
 * vector scene validates; malformed ones (no shapes, unknown kind, unknown keys,
 * non-numeric geometry) are rejected — the closed schema is what keeps the inline-SVG
 * renderer safe (it never sees raw markup, only typed numeric shapes).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerDrawingArtifactType } from '../artifactTypes.js';
import { validateArtifact, isRegisteredArtifactType } from '../../../host/artifactTypes.js';
import { validateDrawingDoc } from '../validateDrawingDoc.js';

const valid = {
  title: 'House',
  width: 400, height: 300,
  shapes: [
    { kind: 'rect', x: 120, y: 150, width: 160, height: 120, fill: '#e8d6b3', stroke: '#7a5c2e', strokeWidth: 2 },
    { kind: 'polygon', points: [{ x: 110, y: 150 }, { x: 200, y: 90 }, { x: 290, y: 150 }], fill: '#b5532f' },
    { kind: 'text', x: 150, y: 285, text: 'Home', fontSize: 16 },
  ],
};

describe('canvas.drawing artifact type', () => {
  beforeAll(() => { registerDrawingArtifactType(); });

  it('registers canvas.drawing', () => {
    expect(isRegisteredArtifactType('canvas.drawing')).toBe(true);
  });
  it('accepts a valid vector scene', () => {
    expect(validateArtifact('canvas.drawing', valid)).toMatchObject({ registered: true, valid: true });
  });
  it('rejects a drawing with no shapes', () => {
    expect(validateArtifact('canvas.drawing', { shapes: [] }).valid).toBe(false);
  });
  it('rejects an unknown shape kind', () => {
    expect(validateArtifact('canvas.drawing', { shapes: [{ kind: 'spline' }] }).valid).toBe(false);
  });
  it('rejects unknown shape keys (closed schema)', () => {
    expect(validateArtifact('canvas.drawing', { shapes: [{ kind: 'rect', onload: 'x' }] }).valid).toBe(false);
  });
  it('rejects non-numeric geometry', () => {
    expect(validateArtifact('canvas.drawing', { shapes: [{ kind: 'circle', cx: '10', cy: 10, r: 5 }] }).valid).toBe(false);
  });
  it('rejects a malformed point (non-numeric)', () => {
    expect(validateArtifact('canvas.drawing', { shapes: [{ kind: 'polyline', points: [{ x: 'a', y: 1 }] }] }).valid).toBe(false);
  });
  // ADR 0317 follow-up — the additive in-plane rotation field.
  it('accepts an optional numeric rotation on a shape; rejects a non-numeric one', () => {
    expect(validateArtifact('canvas.drawing', { shapes: [{ kind: 'rect', x: 0, y: 0, width: 10, height: 10, rotation: 30 }] }).valid).toBe(true);
    expect(validateArtifact('canvas.drawing', { shapes: [{ kind: 'rect', rotation: '30' }] }).valid).toBe(false);
  });
});

// ADR 0333 Phase 3 — freehand ink + element chrome, exercised through BOTH
// mirrors (the JSON schema via validateArtifact AND the editor-doc validator)
// so the two can't drift.

const inkStroke = {
  kind: 'stroke',
  points: [{ x: 0, y: 0 }, { x: 10, y: 4 }, { x: 22, y: 9 }],
  pressures: [0.2, 0.6, 0.4],
  simulatePressure: false,
  size: 6, color: '#264a73', opacity: 0.9, taperStart: 0, taperEnd: 12,
  name: 'Ink 1', locked: false, hidden: false, groupId: 'g1',
};

describe('canvas.drawing — ADR 0333 Phase 3 (stroke kind + chrome), dual-mirror', () => {
  beforeAll(() => { registerDrawingArtifactType(); });

  it('accepts a stroke with spine, pressure track, chrome — through both mirrors', () => {
    const doc = { shapes: [inkStroke] };
    expect(validateArtifact('canvas.drawing', doc).valid).toBe(true);
    expect(validateDrawingDoc(doc).errors).toEqual([]);
  });
  it('rejects out-of-range pressures through both mirrors', () => {
    const doc = { shapes: [{ ...inkStroke, pressures: [1.5] }] };
    expect(validateArtifact('canvas.drawing', doc).valid).toBe(false);
    expect(validateDrawingDoc(doc).errors.length).toBeGreaterThan(0);
  });
  it('rejects a 601-point spine through both mirrors (the split budget)', () => {
    const pts = Array.from({ length: 601 }, (_, i) => ({ x: i, y: i }));
    const doc = { shapes: [{ kind: 'stroke', points: pts, size: 4 }] };
    expect(validateArtifact('canvas.drawing', doc).valid).toBe(false);
    expect(validateDrawingDoc(doc).errors.length).toBeGreaterThan(0);
  });
  it('accepts a 600-point polyline (the shared cap raise) through both mirrors', () => {
    const pts = Array.from({ length: 600 }, (_, i) => ({ x: i, y: i }));
    const doc = { shapes: [{ kind: 'polyline', points: pts }] };
    expect(validateArtifact('canvas.drawing', doc).valid).toBe(true);
    expect(validateDrawingDoc(doc).errors).toEqual([]);
  });
  it('rejects non-boolean chrome + oversize name/groupId through both mirrors', () => {
    for (const bad of [{ locked: 'yes' }, { hidden: 1 }, { name: 'x'.repeat(81) }, { groupId: 'g'.repeat(41) }]) {
      const doc = { shapes: [{ kind: 'rect', x: 0, y: 0, width: 5, height: 5, ...bad }] };
      expect(validateArtifact('canvas.drawing', doc).valid).toBe(false);
      expect(validateDrawingDoc(doc).errors.length).toBeGreaterThan(0);
    }
  });
  it('caps shapes at 2000 through both mirrors', () => {
    const shapes = Array.from({ length: 2001 }, () => ({ kind: 'rect', x: 0, y: 0, width: 1, height: 1 }));
    expect(validateArtifact('canvas.drawing', { shapes }).valid).toBe(false);
    expect(validateDrawingDoc({ shapes }).errors.length).toBeGreaterThan(0);
    const ok = Array.from({ length: 2000 }, () => ({ kind: 'rect', x: 0, y: 0, width: 1, height: 1 }));
    expect(validateArtifact('canvas.drawing', { shapes: ok }).valid).toBe(true);
  });
});

// ADR 0333 Phase 4 — the arrow kind (dual-mirror).
describe('canvas.drawing — ADR 0333 Phase 4 (arrow kind)', () => {
  beforeAll(() => { registerDrawingArtifactType(); });

  it('accepts an arrow with endpoint heads through both mirrors', () => {
    const doc = { shapes: [{ kind: 'arrow', x1: 0, y1: 0, x2: 100, y2: 40, strokeWidth: 2, endHead: 'arrow', startHead: 'none' }] };
    expect(validateArtifact('canvas.drawing', doc).valid).toBe(true);
    expect(validateDrawingDoc(doc).errors).toEqual([]);
  });
  it('rejects an unknown head value through both mirrors', () => {
    const doc = { shapes: [{ kind: 'arrow', x1: 0, y1: 0, x2: 10, y2: 10, endHead: 'barb' }] };
    expect(validateArtifact('canvas.drawing', doc).valid).toBe(false);
    expect(validateDrawingDoc(doc).errors.length).toBeGreaterThan(0);
  });
});

// ADR 0333 Phase 7 — doc-level guides (dual-mirror).
describe('canvas.drawing — ADR 0333 Phase 7 (grid + symmetry doc fields)', () => {
  beforeAll(() => { registerDrawingArtifactType(); });
  const base = { shapes: [{ kind: 'rect', x: 0, y: 0, width: 5, height: 5 }] };

  it('accepts the guide fields through both mirrors', () => {
    const doc = { ...base, gridSize: 20, gridShow: true, gridSnap: true, symmetry: 'radial', symmetryRotational: true };
    expect(validateArtifact('canvas.drawing', doc).valid).toBe(true);
    expect(validateDrawingDoc(doc).errors).toEqual([]);
  });
  it('rejects out-of-range gridSize and unknown symmetry through both mirrors', () => {
    for (const bad of [{ gridSize: 0 }, { gridSize: 501 }, { symmetry: 'diagonal' }, { gridShow: 1 }]) {
      const doc = { ...base, ...bad };
      expect(validateArtifact('canvas.drawing', doc).valid).toBe(false);
      expect(validateDrawingDoc(doc).errors.length).toBeGreaterThan(0);
    }
  });
});

// ADR 0333 grade pass — the security + drift fixtures the pass added.
describe('canvas.drawing — ADR 0333 grade-pass hardening (dual-mirror)', () => {
  beforeAll(() => { registerDrawingArtifactType(); });
  it('CODE-D4: rejects url()/var() paint through BOTH mirrors; accepts safe colors', () => {
    for (const bad of [{ fill: 'url(//evil.tld/p#f)' }, { stroke: 'var(--x)' }, { fill: 'url(x)' }]) {
      const doc = { shapes: [{ kind: 'rect', x: 0, y: 0, width: 5, height: 5, ...bad }] };
      expect(validateArtifact('canvas.drawing', doc).valid).toBe(false);
      expect(validateDrawingDoc(doc).errors.length).toBeGreaterThan(0);
    }
    for (const good of ['#e8d6b3', '#fff', 'rgb(10,20,30)', 'oklch(58% 0.13 40)', 'currentColor', 'none', 'red']) {
      const doc = { shapes: [{ kind: 'rect', x: 0, y: 0, width: 5, height: 5, fill: good }] };
      expect(validateArtifact('canvas.drawing', doc).valid).toBe(true);
      expect(validateDrawingDoc(doc).errors).toEqual([]);
    }
  });

  it('CODE-D9/DATA-D3: rejects extra point keys + non-finite coords through BOTH mirrors', () => {
    for (const pts of [[{ x: 1, y: 2, blob: 'x' }], [{ x: 1, y: 2, z: 0 }]]) {
      const doc = { shapes: [{ kind: 'polyline', points: pts }] };
      expect(validateArtifact('canvas.drawing', doc).valid).toBe(false);
      expect(validateDrawingDoc(doc).errors.length).toBeGreaterThan(0);
    }
    // Non-finite coordinate: the editor-doc validator rejects (the JSON schema's
    // type:number admits Infinity, so this is the validator's added guard).
    const inf = { shapes: [{ kind: 'polyline', points: [{ x: 1e400, y: 0 }] }] };
    expect(validateDrawingDoc(inf).errors.length).toBeGreaterThan(0);
  });
});

describe('canvas.drawing — ADR 0401 follow-through (image kind), dual-mirror', () => {
  beforeAll(() => { registerDrawingArtifactType(); });
  const HOST_SRC = '/v1/host/openwop-app/assets/tok_abc-123';

  it('accepts an image shape with a HOST media-asset src — through both mirrors', () => {
    const doc = { shapes: [{ kind: 'image', x: 20, y: 20, width: 160, height: 120, src: HOST_SRC, opacity: 0.9, rotation: 15, name: 'logo', hidden: false }] };
    expect(validateArtifact('canvas.drawing', doc)).toMatchObject({ registered: true, valid: true });
    expect(validateDrawingDoc(doc).errors).toEqual([]);
  });

  it('REJECTS an external URL src (viewer-beacon guard) — through both mirrors', () => {
    for (const src of ['https://evil.example/x.png', 'http://replicate.delivery/a.png', 'data:image/png;base64,AAAA', '//evil.example/x.png', 'javascript:alert(1)']) {
      const doc = { shapes: [{ kind: 'image', x: 0, y: 0, width: 10, height: 10, src }] };
      expect(validateArtifact('canvas.drawing', doc).valid, src).toBe(false);
      expect(validateDrawingDoc(doc).errors.length, src).toBeGreaterThan(0);
    }
  });

  it('rejects a src on no shape... anywhere src is malformed (traversal, empty token)', () => {
    for (const src of ['/v1/host/openwop-app/assets/', '/v1/host/openwop-app/assets/../../etc', '/v1/host/openwop-app/assets/tok?x=1']) {
      const doc = { shapes: [{ kind: 'image', x: 0, y: 0, width: 10, height: 10, src }] };
      expect(validateDrawingDoc(doc).errors.length, src).toBeGreaterThan(0);
    }
  });
});
