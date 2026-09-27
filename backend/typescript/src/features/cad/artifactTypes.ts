/**
 * CAD canvas artifact type (ADR 0153 Phase 4). `canvas.cad` is a constrained
 * parametric-solid model — a closed set of primitive solids (box/cylinder/sphere/cone)
 * with numeric position + dimensions + optional glTF-aligned material (metallic/
 * roughness) — emitted by the CAD Modeler agent or a run and rendered inline in two
 * modes: a dependency-free orthographic SVG projection AND a read-only hand-rolled 3D
 * orbit viewer (ADR 0310 Phase-C follow-up; no Three.js — the no-dep discipline, lazy
 * chunk). Material renders as APPROXIMATE shading, not true PBR.
 */
import { registerArtifactType } from '../../host/artifactTypes.js';
import { cadBomSchema, CAD_BOM_TYPE_ID } from './bom.js';
import { CAD_MATERIAL_IDS } from './cadMaterials.js';

export function cadSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['solids'],
    properties: {
      name: { type: 'string', maxLength: 200 },
      units: { type: 'string', enum: ['mm', 'cm', 'm', 'in'] },
      // ADR 0388 P4 — the 2D sketch sub-document (points/lines/arcs on the
      // DERIVED z=0 construction plane) + its constraint set. Solved ONLY by
      // the deterministic host solver — never free-hand model output.
      sketch: {
        type: 'object',
        required: ['points', 'segments', 'constraints'],
        properties: {
          points: {
            type: 'array', minItems: 1, maxItems: 200,
            items: {
              type: 'object', required: ['x', 'y'],
              properties: { x: { type: 'number' }, y: { type: 'number' } },
              additionalProperties: false,
            },
          },
          segments: {
            type: 'array', maxItems: 200,
            items: {
              type: 'object', required: ['kind', 'a', 'b'],
              properties: {
                kind: { type: 'string', enum: ['line', 'arc'] },
                a: { type: 'integer', minimum: 0 }, b: { type: 'integer', minimum: 0 },
                r: { type: 'number', exclusiveMinimum: 0 },
              },
              additionalProperties: false,
            },
          },
          constraints: {
            type: 'array', maxItems: 300,
            items: {
              type: 'object', required: ['kind'],
              properties: {
                kind: { type: 'string', enum: ['coincident', 'concentric', 'parallel', 'perpendicular', 'tangent', 'equal', 'horizontal', 'vertical', 'fixed', 'distance', 'angle', 'symmetric'] },
                points: { type: 'array', maxItems: 4, items: { type: 'integer', minimum: 0 } },
                segments: { type: 'array', maxItems: 4, items: { type: 'integer', minimum: 0 } },
                value: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      // ADR 0388 P3 — typed annotated dimensions (values DERIVED from the
      // referenced solid at read time, never stored; flat closed-world
      // tolerance grammar; solid referenced by index — the positional model).
      dimensions: {
        type: 'array', maxItems: 100,
        items: {
          type: 'object',
          required: ['kind', 'solid'],
          properties: {
            kind: { type: 'string', enum: ['linear', 'angular', 'radial', 'diameter', 'arc', 'ordinate'] },
            solid: { type: 'integer', minimum: 0 },
            axis: { type: 'string', enum: ['x', 'y', 'z'] },
            unit: { type: 'string', enum: ['mm', 'cm', 'm', 'in'] },
            tolType: { type: 'string', enum: ['symmetric', 'asymmetric', 'limit'] },
            tolA: { type: 'number', minimum: 0 },
            tolB: { type: 'number', minimum: 0 },
            label: { type: 'string', maxLength: 80 },
          },
          additionalProperties: false,
        },
      },
      solids: {
        type: 'array', minItems: 1, maxItems: 200,
        items: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['box', 'cylinder', 'sphere', 'cone', 'mesh'] },
            x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
            width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 }, depth: { type: 'number', minimum: 0 },
            radius: { type: 'number', minimum: 0 }, length: { type: 'number', minimum: 0 },
            // ADR 0317 follow-up: in-plane rotation of the front-elevation
            // footprint (degrees, clockwise on screen — the only rotation the
            // orthographic projection can honestly depict; X/Y tilt needs the
            // Tier-2 WebGL viewer). Optional, additive.
            rotation: { type: 'number' },
            color: { type: 'string', maxLength: 40 }, label: { type: 'string', maxLength: 80 },
            // ADR 0310 Phase-C follow-up: glTF-aligned material data (0..1). The
            // 3D viewer renders these as APPROXIMATE metallic/roughness shading (not
            // true PBR); the field set is the faithful upgrade path. Optional, additive.
            metallic: { type: 'number', minimum: 0, maximum: 1 },
            roughness: { type: 'number', minimum: 0, maximum: 1 },
            // ADR 0388 P5 — closed-world library material (resolves to catalog
            // paint; wins over inline color/metallic/roughness) + an emissive
            // #hex tint. Safe-paint grammar — never free material JSON.
            materialId: { type: 'string', enum: [...CAD_MATERIAL_IDS] },
            emissive: { type: 'string', pattern: '^#[0-9a-fA-F]{3,8}$' },
            // ADR 0388 P1 (architect R1/R2): an imported mesh is a REFERENCE
            // citizen — `assetRef` names a content-addressed, host-served mesh
            // asset (canonical binary STL bytes); geometry is never inlined.
            assetRef: { type: 'string', maxLength: 200 },
            // Uniform scale for a referenced mesh (mesh kind only).
            scale: { type: 'number', exclusiveMinimum: 0 },
          },
          additionalProperties: false,
          // A `mesh` solid MUST reference its asset (closed world — a mesh
          // without geometry is not representable).
          allOf: [
            {
              if: { properties: { kind: { const: 'mesh' } }, required: ['kind'] },
              then: { required: ['assetRef'] },
            },
          ],
        },
      },
    },
    additionalProperties: false,
  };
}

let registered = false;

/** Register `canvas.cad`. Idempotent; called at boot from the feature. */
export function registerCadArtifactType(): void {
  if (registered) return;
  registerArtifactType({
    artifactTypeId: 'canvas.cad',
    title: 'CAD Model',
    schema: cadSchema(),
    // ADR 0388 P1 — the facets become TRUE in the same change that implements
    // them (the 0328 honesty-first rule): STL/GLTF via the meshCodec twin,
    // PNG via the canvas/exportUtils seam in the editor.
    export: ['json', 'stl', 'gltf', 'png'],
    registrationSource: 'host',
  });
  // ADR 0388 P2 — the BOM projection is its OWN host-registered artifact type
  // (the interactive-artifacts multi-type precedent): computed, read-only,
  // exportable as CSV.
  registerArtifactType({
    artifactTypeId: CAD_BOM_TYPE_ID,
    title: 'CAD Bill of Materials',
    schema: cadBomSchema(),
    export: ['json', 'csv'],
    registrationSource: 'host',
  });
  registered = true;
}
