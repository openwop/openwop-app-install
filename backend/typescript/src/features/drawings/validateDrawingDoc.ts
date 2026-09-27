/**
 * Editor-doc validation for `canvas.drawing` working copies (ADR 0310 Phase C).
 * A PURE mirror of the artifact schema's hard caps (artifactTypes.ts — 1..2000
 * shapes, the 10-kind closed world incl. `stroke`/`arrow`/`image`, numeric geometry,
 * paint-value grammar + length caps, the doc-level guide fields): elements are
 * positional, so the working copy needs NO identity fields. Hard errors reject
 * the PATCH with 422; no soft warnings.
 */

/** A paint value must be a SAFE color grammar (ADR 0333 grade pass CODE-D4) —
 *  `url(...)`/`var(...)` in an SVG paint attribute triggers a cross-origin
 *  fetch on render (a zero-click IP/read-receipt beacon per viewer) and rides
 *  into exported files. Allow hex, rgb()/hsl()/oklch() numeric forms, CSS
 *  keywords (letters only), `currentColor`, `none`, `transparent`. */
const PAINT_RE = /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([0-9.,%\/\sdeg]+\)|[a-zA-Z]+)$/;
function badPaint(v: string): boolean { return v.length > 0 && !PAINT_RE.test(v.trim()); }

export interface DrawingValidation {
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
}

// Exported so the agent-prompt parity test can pin prompts/illustrator.md to this closed world.
export const DRAWING_SHAPE_KINDS = ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'stroke', 'arrow', 'image'] as const;
const KINDS = new Set<string>(DRAWING_SHAPE_KINDS);
// ADR 0333 Phase 4 — arrow endpoint heads (computed polygons, never markers).
const HEAD_FIELDS = new Set(['startHead', 'endHead']);
const HEADS = new Set(['none', 'arrow']);
// ADR 0333 Phase 3: 500→2000 (ink multiplies element counts; culling is a recorded follow-up).
export const MAX_SHAPES = 2000;
// Shared by polyline/polygon and the stroke spine (was 200; the 600-point
// tldraw budget — the editor splits longer strokes).
export const MAX_POINTS = 600;

const NUM_FIELDS: Record<string, { min?: number; max?: number }> = {
  x: {}, y: {}, cx: {}, cy: {}, x1: {}, y1: {}, x2: {}, y2: {},
  width: { min: 0 }, height: { min: 0 }, rx: { min: 0 }, ry: { min: 0 }, r: { min: 0 },
  fontSize: { min: 1, max: 400 }, strokeWidth: { min: 0, max: 100 }, opacity: { min: 0, max: 1 },
  rotation: {}, // ADR 0317 follow-up — in-plane degrees (any real, wraps)
  // ADR 0333 Phase 3 — freehand ink.
  size: { min: 0.5, max: 100 }, taperStart: { min: 0, max: 4000 }, taperEnd: { min: 0, max: 4000 },
};
const STR_FIELDS: Record<string, number> = {
  text: 400, fill: 40, stroke: 40,
  // ADR 0333 Phase 3 — ink color + element chrome.
  color: 40, name: 80, groupId: 40,
};
const BOOL_FIELDS = new Set(['simulatePressure', 'locked', 'hidden']);

/** The `image` kind's src (ADR 0401 follow-through) — a HOST media-asset serve
 *  path ONLY. An external URL in a rendered drawing is a per-viewer read-receipt
 *  beacon (the exact CODE-D4 class the paint grammar bans) and would also break
 *  the SVG-as-image PNG export; the media library (incl. AI generate/edit) is
 *  the ingestion path for outside imagery. Mirrors the artifact schema pattern. */
const IMAGE_SRC_RE = /^\/v1\/host\/openwop-app\/assets\/[A-Za-z0-9_-]{1,512}$/;

export function validateDrawingDoc(state: Record<string, unknown>): DrawingValidation {
  const errors: { path: string; message: string }[] = [];
  const err = (path: string, message: string): void => { errors.push({ path, message }); };

  if (state.title !== undefined && (typeof state.title !== 'string' || state.title.length > 200)) {
    err('title', 'title must be a string of at most 200 characters');
  }
  for (const dim of ['width', 'height'] as const) {
    const v = state[dim];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 4000)) {
      err(dim, `${dim} must be a number between 1 and 4000`);
    }
  }

  const shapes = state.shapes;
  if (!Array.isArray(shapes) || shapes.length === 0) {
    err('shapes', 'a drawing needs at least one shape');
    return { errors, warnings: [] };
  }
  if (shapes.length > MAX_SHAPES) err('shapes', `a drawing holds at most ${MAX_SHAPES} shapes`);

  shapes.forEach((raw, i) => {
    const path = `shapes[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      err(path, 'each shape must be an object');
      return;
    }
    const s = raw as Record<string, unknown>;
    if (typeof s.kind !== 'string' || !KINDS.has(s.kind)) {
      err(`${path}.kind`, `kind must be one of: ${[...KINDS].join(', ')}`);
    }
    for (const [k, v] of Object.entries(s)) {
      if (k === 'kind') continue;
      if (k === 'points') {
        // ADR 0333 grade pass CODE-D9/DATA-D3: points are CLOSED {x,y} finite
        // pairs — matching the schema's `additionalProperties:false` POINT
        // (was open here: a drift channel + a NaN/Infinity geometry vector).
        const badPoint = (p: unknown): boolean => {
          if (!p || typeof p !== 'object' || Array.isArray(p)) return true;
          const o = p as Record<string, unknown>;
          if (Object.keys(o).some((kk) => kk !== 'x' && kk !== 'y')) return true;
          return !Number.isFinite(o.x) || !Number.isFinite(o.y);
        };
        if (!Array.isArray(v) || v.length > MAX_POINTS || v.some(badPoint)) {
          err(`${path}.points`, `points must be at most ${MAX_POINTS} finite {x,y} pairs`);
        }
        continue;
      }
      if (k === 'pressures') {
        // ADR 0333 Phase 3 — the stroke spine's pressure track (pairs with points).
        if (!Array.isArray(v) || v.length > MAX_POINTS || v.some((p) => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1)) {
          err(`${path}.pressures`, `pressures must be at most ${MAX_POINTS} numbers in [0, 1]`);
        }
        continue;
      }
      if (BOOL_FIELDS.has(k)) {
        if (typeof v !== 'boolean') err(`${path}.${k}`, `${k} must be a boolean`);
        continue;
      }
      if (HEAD_FIELDS.has(k)) {
        if (typeof v !== 'string' || !HEADS.has(v)) err(`${path}.${k}`, `${k} must be one of: ${[...HEADS].join(', ')}`);
        continue;
      }
      if (k in NUM_FIELDS) {
        const spec = NUM_FIELDS[k]!;
        if (typeof v !== 'number' || !Number.isFinite(v) || (spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) {
          err(`${path}.${k}`, `${k} must be a number${spec.min !== undefined || spec.max !== undefined ? ` within [${spec.min ?? '-∞'}, ${spec.max ?? '∞'}]` : ''}`);
        }
        continue;
      }
      if (k === 'src') {
        if (typeof v !== 'string' || v.length > 600 || !IMAGE_SRC_RE.test(v)) {
          err(`${path}.src`, 'src must be a host media-asset serve path (/v1/host/openwop-app/assets/<token>) — external URLs are not allowed');
        }
        continue;
      }
      if (k in STR_FIELDS) {
        if (typeof v !== 'string' || v.length > STR_FIELDS[k]!) { err(`${path}.${k}`, `${k} must be a string of at most ${STR_FIELDS[k]} characters`); continue; }
        // Paint fields carry a safe-color grammar (CODE-D4); non-paint strings
        // (text, name, groupId) are free text within their length cap.
        if ((k === 'fill' || k === 'stroke' || k === 'color') && badPaint(v)) err(`${path}.${k}`, `${k} must be a safe color (hex, rgb/hsl/oklch, keyword, currentColor, none)`);
        continue;
      }
      err(`${path}.${k}`, `unknown shape field '${k}'`);
    }
  });

  // ADR 0333 Phase 7 — doc-level guides.
  const gs = state.gridSize;
  if (gs !== undefined && (typeof gs !== 'number' || !Number.isFinite(gs) || gs < 1 || gs > 500)) {
    err('gridSize', 'gridSize must be a number between 1 and 500');
  }
  for (const b of ['gridShow', 'gridSnap', 'symmetryRotational'] as const) {
    if (state[b] !== undefined && typeof state[b] !== 'boolean') err(b, `${b} must be a boolean`);
  }
  const SYM = new Set(['off', 'vertical', 'horizontal', 'quadrant', 'radial']);
  if (state.symmetry !== undefined && (typeof state.symmetry !== 'string' || !SYM.has(state.symmetry))) {
    err('symmetry', `symmetry must be one of: ${[...SYM].join(', ')}`);
  }

  const DOC_KEYS = new Set(['title', 'width', 'height', 'shapes', 'gridSize', 'gridShow', 'gridSnap', 'symmetry', 'symmetryRotational']);
  for (const key of Object.keys(state)) {
    if (!DOC_KEYS.has(key)) err(key, `unknown drawing field '${key}'`);
  }

  return { errors, warnings: [] };
}
