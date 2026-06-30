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
});
