/**
 * Drawings canvas artifact type (ADR 0153 Phase 4). `canvas.drawing` is a constrained
 * vector scene — a closed set of typed shapes (rect/circle/ellipse/line/polyline/
 * polygon/text) with numeric geometry — emitted by the Illustrator agent or a run and
 * rendered inline in the chat workbench as SAFE inline SVG (no script, no foreignObject,
 * no raw markup). The "raster/vector" canvas of Phase 4; `cad` (WebGL) is separate.
 */
import { registerArtifactType } from '../../host/artifactTypes.js';

const POINT = { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } }, additionalProperties: false };
// ADR 0333 grade pass CODE-D4 — a safe SVG paint grammar (no url()/var() that
// would trigger a cross-origin fetch on render). Mirrors validateDrawingDoc.
const PAINT = { type: 'string', maxLength: 40, pattern: '^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\\([0-9.,%/\\sdeg]+\\)|[a-zA-Z]+)$' };

export function drawingSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['shapes'],
    properties: {
      title: { type: 'string', maxLength: 200 },
      width: { type: 'number', minimum: 1, maximum: 4000 },
      height: { type: 'number', minimum: 1, maximum: 4000 },
      // ADR 0333 Phase 7 — doc-level guides (grid + symmetry assist). FLAT
      // fields so the editor panel edits them through the built-in widgets.
      gridSize: { type: 'number', minimum: 1, maximum: 500 },
      gridShow: { type: 'boolean' },
      gridSnap: { type: 'boolean' },
      symmetry: { type: 'string', enum: ['off', 'vertical', 'horizontal', 'quadrant', 'radial'] },
      symmetryRotational: { type: 'boolean' },
      shapes: {
        // ADR 0333 Phase 3: 500→2000 (freehand ink multiplies element counts).
        // (Editor viewport culling is a recorded ADR 0333 follow-up, not shipped.)
        type: 'array', minItems: 1, maxItems: 2000,
        items: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'stroke', 'arrow', 'image'] },
            x: { type: 'number' }, y: { type: 'number' },
            width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 },
            rx: { type: 'number', minimum: 0 }, ry: { type: 'number', minimum: 0 },
            cx: { type: 'number' }, cy: { type: 'number' }, r: { type: 'number', minimum: 0 },
            x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
            // Shared by polyline/polygon (was 200) and the ADR 0333 Phase 3
            // `stroke` spine (split-and-continue caps a stroke at 600 points —
            // the tldraw budget; a 600-point polyline is harmless).
            points: { type: 'array', maxItems: 600, items: POINT },
            text: { type: 'string', maxLength: 400 }, fontSize: { type: 'number', minimum: 1, maximum: 400 },
            fill: PAINT, stroke: PAINT,
            strokeWidth: { type: 'number', minimum: 0, maximum: 100 }, opacity: { type: 'number', minimum: 0, maximum: 1 },
            // ADR 0317 follow-up: in-plane rotation (degrees, clockwise) about the
            // shape's own bounding-box centre. Optional, additive.
            rotation: { type: 'number' },
            // ADR 0333 Phase 3 — freehand ink (kind 'stroke'): a point+pressure
            // SPINE re-rendered as a variable-width outline (never a baked
            // polygon). `pressures` pairs with `points`; `size` is the base
            // width; `color` is the ink; mice get velocity-simulated pressure.
            pressures: { type: 'array', maxItems: 600, items: { type: 'number', minimum: 0, maximum: 1 } },
            simulatePressure: { type: 'boolean' },
            size: { type: 'number', minimum: 0.5, maximum: 100 },
            color: PAINT,
            taperStart: { type: 'number', minimum: 0, maximum: 4000 }, taperEnd: { type: 'number', minimum: 0, maximum: 4000 },
            // ADR 0333 Phase 3 — element chrome (generic scene structure).
            name: { type: 'string', maxLength: 80 },
            locked: { type: 'boolean' }, hidden: { type: 'boolean' },
            groupId: { type: 'string', maxLength: 40 },
            // ADR 0333 Phase 4 — the `arrow` kind (line fields + endpoint
            // heads; heads render as computed polygons — never SVG markers).
            startHead: { type: 'string', enum: ['none', 'arrow'] },
            endHead: { type: 'string', enum: ['none', 'arrow'] },
            // ADR 0401 follow-through — the `image` kind: a HOST media-asset
            // serve path only (external URLs = viewer beacons + break the
            // SVG-as-image PNG export). Mirrors validateDrawingDoc.
            src: { type: 'string', maxLength: 600, pattern: '^/v1/host/openwop-app/assets/[A-Za-z0-9_-]{1,512}$' },
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
