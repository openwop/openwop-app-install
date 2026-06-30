/**
 * feature.cad.nodes — the producer for ADR 0153 Phase 4 CAD canvases. The `render`
 * node normalizes a requested parametric model into the `canvas.cad` shape and emits
 * the typed `{ artifact }` envelope (ADR 0055/0083); the chat workbench renders it as an
 * orthographic SVG projection. Constrained typed JSON (host registry does authoritative
 * AJV validation); this node does structural normalization + fail-fast. Pure-JS, Node-20.
 */

const KINDS = new Set(['box', 'cylinder', 'sphere', 'cone']);
const NUM = ['x', 'y', 'z', 'width', 'height', 'depth', 'radius', 'length'];

function fail(message) { return Object.assign(new Error(message), { code: 'validation_error' }); }
function safeParse(s) { if (typeof s !== 'string') return null; try { return JSON.parse(s); } catch { return null; } }
function str(v, max) { if (typeof v !== 'string') return undefined; const t = v.trim(); if (!t) return undefined; return max && t.length > max ? t.slice(0, max) : t; }

function normalizeSolid(raw, index) {
  if (!raw || typeof raw !== 'object') throw fail(`solid ${index} is not an object`);
  if (!KINDS.has(raw.kind)) throw fail(`solid ${index} has unknown kind '${raw.kind}'`);
  const out = { kind: raw.kind };
  for (const k of NUM) if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) out[k] = raw[k];
  const color = str(raw.color, 40); if (color) out.color = color;
  const label = str(raw.label, 80); if (label) out.label = label;
  return out;
}

export async function render(ctx) {
  const i = ctx.inputs ?? {};
  const m = (i.model && typeof i.model === 'object') ? i.model : safeParse(i.source) ?? i;

  const solidsIn = Array.isArray(m.solids) ? m.solids : null;
  if (!solidsIn || solidsIn.length === 0) throw fail('`solids` is required — a non-empty array of primitive solids');
  if (solidsIn.length > 200) throw fail('a model may have at most 200 solids');

  const payload = { solids: solidsIn.map(normalizeSolid) };
  const name = str(m.name, 200); if (name) payload.name = name;
  if (typeof m.units === 'string' && ['mm', 'cm', 'm', 'in'].includes(m.units)) payload.units = m.units;

  return {
    status: 'success',
    outputs: {
      solidCount: payload.solids.length,
      artifact: { artifactTypeId: 'canvas.cad', payload, ...(name ? { title: name } : {}) },
    },
  };
}

export const nodes = { 'feature.cad.nodes.render': render };
