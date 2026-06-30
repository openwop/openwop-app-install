/**
 * feature.drawings.nodes — the producer for ADR 0153 Phase 4 drawing canvases. The
 * `render` node normalizes a requested vector scene into the `canvas.drawing` shape and
 * emits the typed `{ artifact }` envelope (ADR 0055/0083); the chat workbench renders it
 * as SAFE inline SVG. Constrained typed JSON (host registry does authoritative AJV
 * validation); this node does structural normalization + fail-fast. Pure-JS, Node-20.
 */

const KINDS = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text']);
const NUM = ['x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'fontSize', 'strokeWidth', 'opacity'];

function fail(message) { return Object.assign(new Error(message), { code: 'validation_error' }); }
function safeParse(s) { if (typeof s !== 'string') return null; try { return JSON.parse(s); } catch { return null; } }
function str(v, max) { if (typeof v !== 'string') return undefined; const t = v.trim(); if (!t) return undefined; return max && t.length > max ? t.slice(0, max) : t; }

function normalizeShape(raw, index) {
  if (!raw || typeof raw !== 'object') throw fail(`shape ${index} is not an object`);
  if (!KINDS.has(raw.kind)) throw fail(`shape ${index} has unknown kind '${raw.kind}'`);
  const out = { kind: raw.kind };
  for (const k of NUM) if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) out[k] = raw[k];
  const text = str(raw.text, 400); if (text) out.text = text;
  const fill = str(raw.fill, 40); if (fill) out.fill = fill;
  const stroke = str(raw.stroke, 40); if (stroke) out.stroke = stroke;
  if (Array.isArray(raw.points)) {
    const points = raw.points
      .filter((p) => p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y))
      .slice(0, 200)
      .map((p) => ({ x: p.x, y: p.y }));
    if (points.length) out.points = points;
  }
  return out;
}

export async function render(ctx) {
  const i = ctx.inputs ?? {};
  const d = (i.drawing && typeof i.drawing === 'object') ? i.drawing : safeParse(i.source) ?? i;

  const shapesIn = Array.isArray(d.shapes) ? d.shapes : null;
  if (!shapesIn || shapesIn.length === 0) throw fail('`shapes` is required — a non-empty array of typed shapes');
  if (shapesIn.length > 500) throw fail('a drawing may have at most 500 shapes');

  const payload = { shapes: shapesIn.map(normalizeShape) };
  const title = str(d.title, 200); if (title) payload.title = title;
  if (typeof d.width === 'number' && d.width > 0 && d.width <= 4000) payload.width = d.width;
  if (typeof d.height === 'number' && d.height > 0 && d.height <= 4000) payload.height = d.height;

  return {
    status: 'success',
    outputs: {
      shapeCount: payload.shapes.length,
      artifact: { artifactTypeId: 'canvas.drawing', payload, ...(title ? { title } : {}) },
    },
  };
}

export const nodes = { 'feature.drawings.nodes.render': render };
