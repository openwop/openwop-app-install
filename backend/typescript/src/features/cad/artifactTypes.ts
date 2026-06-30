/**
 * CAD canvas artifact type (ADR 0153 Phase 4). `canvas.cad` is a constrained
 * parametric-solid model — a closed set of primitive solids (box/cylinder/sphere/cone)
 * with numeric position + dimensions — emitted by the CAD Modeler agent or a run and
 * rendered inline as a dependency-free orthographic SVG projection (an interactive
 * WebGL viewer is a documented follow-up; the FE bundle has no room for Three.js).
 */
import { registerArtifactType } from '../../host/artifactTypes.js';

export function cadSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['solids'],
    properties: {
      name: { type: 'string', maxLength: 200 },
      units: { type: 'string', enum: ['mm', 'cm', 'm', 'in'] },
      solids: {
        type: 'array', minItems: 1, maxItems: 200,
        items: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['box', 'cylinder', 'sphere', 'cone'] },
            x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
            width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 }, depth: { type: 'number', minimum: 0 },
            radius: { type: 'number', minimum: 0 }, length: { type: 'number', minimum: 0 },
            color: { type: 'string', maxLength: 40 }, label: { type: 'string', maxLength: 80 },
          },
          additionalProperties: false,
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
    export: ['json'],
    registrationSource: 'host',
  });
  registered = true;
}
