/**
 * Editor-doc validation for `canvas.cad` working copies (ADR 0310 Phase C).
 * A PURE mirror of the artifact schema's hard caps (artifactTypes.ts — 1..200
 * solids, the 4-kind closed world, numeric dimensions, color/label caps).
 * Positional elements — no identity fields. Hard errors → 422; no warnings.
 */

import { validateSketch, SketchError, type Sketch } from './cadSketch.js';
import { CAD_MATERIAL_IDS } from './cadMaterials.js';

export interface CadValidation {
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
}

// Exported so the agent-prompt parity test can pin prompts/cad-modeler.md to
// this closed world (XCH-CAD-1, LLM-EXCHANGE-AUDIT Wave 3).
// ADR 0388 P1 adds `mesh` — an imported-geometry REFERENCE citizen (assetRef →
// a content-addressed host-served mesh asset; geometry never inlined).
export const CAD_SOLID_KINDS = ['box', 'cylinder', 'sphere', 'cone', 'mesh'] as const;
const KINDS = new Set<string>(CAD_SOLID_KINDS);
const UNITS = new Set(['mm', 'cm', 'm', 'in']);
export const MAX_SOLIDS = 200;

const NUM_FIELDS: Record<string, { min?: number; max?: number; exclusiveMin?: boolean }> = {
  x: {}, y: {}, z: {},
  width: { min: 0 }, height: { min: 0 }, depth: { min: 0 }, radius: { min: 0 }, length: { min: 0 },
  // ADR 0317 follow-up: in-plane (front-elevation) rotation in degrees; any
  // real number (wraps), so no min/max.
  rotation: {},
  // ADR 0388 P1 — schema-mirror fix: metallic/roughness were in the artifact
  // schema (ADR 0310 Phase-C) but missing from this mirror, so an editor doc
  // carrying them 422'd. Mirrored now (0..1).
  metallic: { min: 0, max: 1 },
  roughness: { min: 0, max: 1 },
  // ADR 0388 P1 — uniform scale for a referenced mesh (mesh kind only, > 0).
  scale: { min: 0, exclusiveMin: true },
};
const STR_FIELDS: Record<string, number> = { color: 40, label: 80, assetRef: 200 };
const EMISSIVE_RE = /^#[0-9a-fA-F]{3,8}$/;
/** Fields only a `mesh` solid may carry (closed world per kind). */
const MESH_ONLY_FIELDS = new Set(['assetRef', 'scale']);

export function validateCadDoc(state: Record<string, unknown>): CadValidation {
  const errors: { path: string; message: string }[] = [];
  const err = (path: string, message: string): void => { errors.push({ path, message }); };

  if (state.name !== undefined && (typeof state.name !== 'string' || state.name.length > 200)) {
    err('name', 'name must be a string of at most 200 characters');
  }
  if (state.units !== undefined && (typeof state.units !== 'string' || !UNITS.has(state.units))) {
    err('units', `units must be one of: ${[...UNITS].join(', ')}`);
  }

  const solids = state.solids;
  if (!Array.isArray(solids) || solids.length === 0) {
    err('solids', 'a model needs at least one solid');
    return { errors, warnings: [] };
  }
  if (solids.length > MAX_SOLIDS) err('solids', `a model holds at most ${MAX_SOLIDS} solids`);

  solids.forEach((raw, i) => {
    const path = `solids[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      err(path, 'each solid must be an object');
      return;
    }
    const s = raw as Record<string, unknown>;
    if (typeof s.kind !== 'string' || !KINDS.has(s.kind)) {
      err(`${path}.kind`, `kind must be one of: ${[...KINDS].join(', ')}`);
    }
    for (const [k, v] of Object.entries(s)) {
      if (k === 'kind') continue;
      if (MESH_ONLY_FIELDS.has(k) && s.kind !== 'mesh') {
        err(`${path}.${k}`, `'${k}' is only valid on a mesh solid`);
        continue;
      }
      if (k in NUM_FIELDS) {
        const spec = NUM_FIELDS[k]!;
        const belowMin =
          spec.min !== undefined && typeof v === 'number' && (spec.exclusiveMin ? v <= spec.min : v < spec.min);
        const aboveMax = spec.max !== undefined && typeof v === 'number' && v > spec.max;
        if (typeof v !== 'number' || !Number.isFinite(v) || belowMin || aboveMax) {
          err(`${path}.${k}`, `${k} must be a ${spec.min !== undefined ? 'non-negative ' : ''}number${spec.max !== undefined ? ` ≤ ${spec.max}` : ''}`);
        }
        continue;
      }
      if (k in STR_FIELDS) {
        if (typeof v !== 'string' || v.length > STR_FIELDS[k]!) err(`${path}.${k}`, `${k} must be a string of at most ${STR_FIELDS[k]} characters`);
        continue;
      }
      // ADR 0388 P5 — closed-world library material + safe-paint emissive.
      if (k === 'materialId') {
        if (typeof v !== 'string' || !CAD_MATERIAL_IDS.includes(v)) err(`${path}.materialId`, `materialId must be one of the library materials`);
        continue;
      }
      if (k === 'emissive') {
        if (typeof v !== 'string' || !EMISSIVE_RE.test(v)) err(`${path}.emissive`, 'emissive must be a #hex color');
        continue;
      }
      err(`${path}.${k}`, `unknown solid field '${k}'`);
    }
    // A mesh solid MUST reference its asset (mirrors the schema's if/then).
    if (s.kind === 'mesh' && (typeof s.assetRef !== 'string' || s.assetRef.length === 0)) {
      err(`${path}.assetRef`, 'a mesh solid requires an assetRef');
    }
  });

  // ADR 0388 P3 — dimensions[] mirror (flat tolerance grammar; index refs
  // range-checked; unit must equal the doc unit — open-question 3's ruling).
  const DIM_KINDS = new Set(['linear', 'angular', 'radial', 'diameter', 'arc', 'ordinate']);
  const TOL_TYPES = new Set(['symmetric', 'asymmetric', 'limit']);
  const docUnits = typeof state.units === 'string' ? state.units : 'mm';
  const dims = state.dimensions;
  if (dims !== undefined) {
    if (!Array.isArray(dims)) {
      err('dimensions', 'dimensions must be an array');
    } else {
      if (dims.length > 100) err('dimensions', 'a model holds at most 100 dimensions');
      dims.forEach((raw, i) => {
        const path = `dimensions[${i}]`;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { err(path, 'each dimension must be an object'); return; }
        const d = raw as Record<string, unknown>;
        if (typeof d.kind !== 'string' || !DIM_KINDS.has(d.kind)) err(`${path}.kind`, `kind must be one of: ${[...DIM_KINDS].join(', ')}`);
        if (typeof d.solid !== 'number' || !Number.isInteger(d.solid) || d.solid < 0 || d.solid >= solids.length) {
          err(`${path}.solid`, 'solid must reference an existing solid by index');
        }
        if ((d.kind === 'linear' || d.kind === 'ordinate') && d.axis !== 'x' && d.axis !== 'y' && d.axis !== 'z') {
          err(`${path}.axis`, 'linear/ordinate dimensions require axis x|y|z');
        }
        if (d.axis !== undefined && d.kind !== 'linear' && d.kind !== 'ordinate') {
          err(`${path}.axis`, 'axis is only valid on linear/ordinate dimensions');
        }
        if (d.unit !== undefined && d.unit !== docUnits) {
          err(`${path}.unit`, `dimension unit must equal the document unit (${docUnits})`);
        }
        if (d.tolType !== undefined) {
          if (typeof d.tolType !== 'string' || !TOL_TYPES.has(d.tolType)) {
            err(`${path}.tolType`, `tolType must be one of: ${[...TOL_TYPES].join(', ')}`);
          } else {
            const needB = d.tolType === 'asymmetric' || d.tolType === 'limit';
            if (typeof d.tolA !== 'number' || !Number.isFinite(d.tolA) || d.tolA < 0) err(`${path}.tolA`, 'tolA must be a non-negative number');
            if (needB && (typeof d.tolB !== 'number' || !Number.isFinite(d.tolB) || d.tolB < 0)) err(`${path}.tolB`, 'tolB must be a non-negative number');
            if (d.tolType === 'limit' && typeof d.tolA === 'number' && typeof d.tolB === 'number' && d.tolA < d.tolB) {
              err(`${path}.tolA`, 'limit upper (tolA) must be ≥ lower (tolB)');
            }
          }
        } else if (d.tolA !== undefined || d.tolB !== undefined) {
          err(`${path}.tolType`, 'tolA/tolB require a tolType');
        }
        if (d.label !== undefined && (typeof d.label !== 'string' || d.label.length > 80)) {
          err(`${path}.label`, 'label must be a string of at most 80 characters');
        }
        for (const k of Object.keys(d)) {
          if (!['kind', 'solid', 'axis', 'unit', 'tolType', 'tolA', 'tolB', 'label'].includes(k)) {
            err(`${path}.${k}`, `unknown dimension field '${k}'`);
          }
        }
      });
    }
  }

  // ADR 0388 P4 — sketch mirror (structure via the ONE twin validator).
  if (state.sketch !== undefined) {
    if (!state.sketch || typeof state.sketch !== 'object' || Array.isArray(state.sketch)) {
      err('sketch', 'sketch must be an object');
    } else {
      try {
        validateSketch(state.sketch as unknown as Sketch);
      } catch (e) {
        err('sketch', e instanceof SketchError ? e.message : 'invalid sketch');
      }
    }
  }

  for (const key of Object.keys(state)) {
    if (key !== 'name' && key !== 'units' && key !== 'solids' && key !== 'dimensions' && key !== 'sketch') {
      err(key, `unknown model field '${key}'`);
    }
  }

  return { errors, warnings: [] };
}
