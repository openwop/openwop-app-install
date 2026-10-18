/**
 * Material library (ADR 0388 P5) — closed-world catalog, safe-paint grammar,
 * deterministic recommendations, validator integration, twin parity.
 *
 * Sabotage-witnessed (/grade-tests w34): catalog paint grammar, library-wins
 * precedence, each inline fallback field (color/metallic/roughness), keyword
 * rules + the kind fallback, and the validator's materialId / emissive rules
 * (asserted by error PATH). Parity passes vacuously only without the frontend
 * tree (CAD-G4 — recorded ceiling).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CAD_MATERIALS, CAD_MATERIAL_IDS, recommendMaterial, resolveMaterial } from '../cadMaterials.js';
import { validateCadDoc } from '../validateCadDoc.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('cadMaterials', () => {
  it('every catalog paint is #hex (the safe-paint grammar — nothing can smuggle a URL)', () => {
    for (const m of CAD_MATERIALS) {
      expect(m.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(m.metallic).toBeGreaterThanOrEqual(0);
      expect(m.metallic).toBeLessThanOrEqual(1);
      expect(m.roughness).toBeGreaterThanOrEqual(0);
      expect(m.roughness).toBeLessThanOrEqual(1);
      if (m.emissive) expect(m.emissive).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    }
    expect(new Set(CAD_MATERIAL_IDS).size).toBe(CAD_MATERIALS.length); // unique ids
  });

  it('resolveMaterial: library id wins over inline paint; inline is the fallback', () => {
    expect(resolveMaterial({ materialId: 'steel', color: '#ff0000', metallic: 0 })).toMatchObject({ color: '#8c96a0', metallic: 0.9 });
    expect(resolveMaterial({ color: '#ff0000', metallic: 0.3, roughness: 0.7 })).toEqual({ color: '#ff0000', metallic: 0.3, roughness: 0.7 });
    expect(resolveMaterial({ materialId: 'no-such' })).toEqual({});
  });

  it('recommendMaterial is deterministic keyword→id, with kind fallback', () => {
    expect(recommendMaterial('mounting bracket', 'box')).toBe('steel');
    expect(recommendMaterial('rubber gasket', 'cylinder')).toBe('rubber');
    expect(recommendMaterial('table leg', 'cylinder')).toBe('wood-oak');
    expect(recommendMaterial(undefined, 'sphere')).toBe('plastic-blue');
    expect(recommendMaterial('mystery part', 'box')).toBe('steel');
  });

  it('validator: materialId closed-world; emissive must be #hex', () => {
    const base = { name: 'M', units: 'mm' };
    const paths = (solid: unknown): string[] => validateCadDoc({ ...base, solids: [solid] }).errors.map((e) => e.path);
    expect(paths({ kind: 'box', width: 10, materialId: 'steel' })).toEqual([]);
    expect(paths({ kind: 'box', width: 10, materialId: 'vibranium' })).toEqual(['solids[0].materialId']);
    expect(paths({ kind: 'box', width: 10, emissive: '#ff8800' })).toEqual([]);
    expect(paths({ kind: 'box', width: 10, emissive: 'url(evil)' })).toEqual(['solids[0].emissive']);
  });
});

describe('FE↔BE twin parity', () => {
  it('backend and frontend cadMaterials.ts are BYTE-IDENTICAL', () => {
    const backend = readFileSync(join(here, '..', 'cadMaterials.ts'), 'utf8');
    const frontendPath = join(here, '..', '..', '..', '..', '..', '..', 'frontend', 'react', 'src', 'features', 'cad', 'cadMaterials.ts');
    // GRADE-PASS CAD-G4: the deploy image / a backend-only checkout has no
    // frontend tree — the parity pin runs wherever the full checkout does (CI,
    // dev), and passes vacuously where the twin simply isn't present.
    if (!existsSync(frontendPath)) return;
    const frontend = readFileSync(frontendPath, 'utf8');
    expect(frontend).toBe(backend);
  });
});
