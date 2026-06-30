/**
 * Drawings canvas artifact type (ADR 0153 Phase 4). `canvas.drawing` is a constrained
 * vector scene — a closed set of typed shapes (rect/circle/ellipse/line/polyline/
 * polygon/text) with numeric geometry — emitted by the Illustrator agent or a run and
 * rendered inline in the chat workbench as SAFE inline SVG (no script, no foreignObject,
 * no raw markup). The "raster/vector" canvas of Phase 4; `cad` (WebGL) is separate.
 */
import { registerArtifactType } from '../../host/artifactTypes.js';

const POINT = { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } }, additionalProperties: false };

export function drawingSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['shapes'],
    properties: {
      title: { type: 'string', maxLength: 200 },
      width: { type: 'number', minimum: 1, maximum: 4000 },
      height: { type: 'number', minimum: 1, maximum: 4000 },
      shapes: {
        type: 'array', minItems: 1, maxItems: 500,
        items: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text'] },
            x: { type: 'number' }, y: { type: 'number' },
            width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 },
            rx: { type: 'number', minimum: 0 }, ry: { type: 'number', minimum: 0 },
            cx: { type: 'number' }, cy: { type: 'number' }, r: { type: 'number', minimum: 0 },
            x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
            points: { type: 'array', maxItems: 200, items: POINT },
            text: { type: 'string', maxLength: 400 }, fontSize: { type: 'number', minimum: 1, maximum: 400 },
            fill: { type: 'string', maxLength: 40 }, stroke: { type: 'string', maxLength: 40 },
            strokeWidth: { type: 'number', minimum: 0, maximum: 100 }, opacity: { type: 'number', minimum: 0, maximum: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  };
}

let registered = false;

/** Register `canvas.drawing`. Idempotent; called at boot from the feature. */
export function registerDrawingArtifactType(): void {
  if (registered) return;
  registerArtifactType({
    artifactTypeId: 'canvas.drawing',
    title: 'Drawing',
    schema: drawingSchema(),
    export: ['svg', 'png'],
    registrationSource: 'host',
  });
  registered = true;
}
