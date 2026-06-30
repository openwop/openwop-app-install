/**
 * CAD canvas (ADR 0153 Phase 4) — the host-side contract: `canvas.cad` is a registered
 * artifact type whose schema gates `artifact.created` (ADR 0055). A valid parametric
 * model validates; malformed ones (no solids, unknown kind, unknown keys, non-numeric
 * geometry) are rejected — the closed schema keeps the inline-SVG projection safe.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerCadArtifactType } from '../artifactTypes.js';
import { validateArtifact, isRegisteredArtifactType } from '../../../host/artifactTypes.js';

const valid = {
  name: 'Bracket', units: 'mm',
  solids: [
    { kind: 'box', x: 0, y: 0, z: 0, width: 80, height: 10, depth: 40, color: '#9aa7b4', label: 'base' },
    { kind: 'cylinder', x: 20, y: 10, z: 20, radius: 6, length: 30 },
    { kind: 'sphere', x: 60, y: 25, z: 20, radius: 8 },
  ],
};

describe('canvas.cad artifact type', () => {
  beforeAll(() => { registerCadArtifactType(); });

  it('registers canvas.cad', () => {
    expect(isRegisteredArtifactType('canvas.cad')).toBe(true);
  });
  it('accepts a valid parametric model', () => {
    expect(validateArtifact('canvas.cad', valid)).toMatchObject({ registered: true, valid: true });
  });
  it('rejects a model with no solids', () => {
    expect(validateArtifact('canvas.cad', { solids: [] }).valid).toBe(false);
  });
  it('rejects an unknown solid kind', () => {
    expect(validateArtifact('canvas.cad', { solids: [{ kind: 'torus', radius: 4 }] }).valid).toBe(false);
  });
  it('rejects unknown solid keys (closed schema)', () => {
    expect(validateArtifact('canvas.cad', { solids: [{ kind: 'box', onload: 'x' }] }).valid).toBe(false);
  });
  it('rejects non-numeric geometry', () => {
    expect(validateArtifact('canvas.cad', { solids: [{ kind: 'box', width: '80' }] }).valid).toBe(false);
  });
  it('rejects an unknown units value', () => {
    expect(validateArtifact('canvas.cad', { units: 'furlongs', solids: [{ kind: 'sphere', radius: 1 }] }).valid).toBe(false);
  });
});
