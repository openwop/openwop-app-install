/**
 * CAD canvas (ADR 0153 Phase 4) — the host-side contract: `canvas.cad` is a registered
 * artifact type whose schema gates `artifact.created` (ADR 0055). A valid parametric
 * model validates; malformed ones (no solids, unknown kind, unknown keys, non-numeric
 * geometry) are rejected — the closed schema keeps the inline-SVG projection safe.
 * Each reject asserts the AJV error that fired (instancePath + message), so a
 * fixture failing for an unrelated reason cannot stand in for the rule. Sabotage-
 * witnessed (/grade-tests w34): dropping the solid `additionalProperties:false`,
 * the units/kind enums, `minItems:1`, or the width/rotation `type:number` each
 * turn exactly their case red.
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
    const r = validateArtifact('canvas.cad', { solids: [] });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('/solids must NOT have fewer than 1 items');
  });
  it('rejects an unknown solid kind', () => {
    const r = validateArtifact('canvas.cad', { solids: [{ kind: 'torus', radius: 4 }] });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('/solids/0/kind must be equal to one of the allowed values');
  });
  it('rejects unknown solid keys (closed schema)', () => {
    const r = validateArtifact('canvas.cad', { solids: [{ kind: 'box', onload: 'x' }] });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('/solids/0 must NOT have additional properties');
  });
  it('rejects non-numeric geometry', () => {
    const r = validateArtifact('canvas.cad', { solids: [{ kind: 'box', width: '80' }] });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('/solids/0/width must be number');
  });
  it('rejects an unknown units value', () => {
    const r = validateArtifact('canvas.cad', { units: 'furlongs', solids: [{ kind: 'sphere', radius: 1 }] });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('/units must be equal to one of the allowed values');
  });
  // ADR 0317 follow-up — the additive in-plane rotation field.
  it('accepts an optional numeric rotation on a solid', () => {
    expect(validateArtifact('canvas.cad', { solids: [{ kind: 'box', width: 40, height: 30, depth: 20, rotation: 45 }] }).valid).toBe(true);
  });
  it('rejects a non-numeric rotation', () => {
    const r = validateArtifact('canvas.cad', { solids: [{ kind: 'box', rotation: '45' }] });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('/solids/0/rotation must be number');
  });
});
