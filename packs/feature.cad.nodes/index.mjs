/**
 * feature.cad.nodes — the producer for ADR 0153 Phase 4 CAD canvases. The `render`
 * node normalizes a requested parametric model into the `canvas.cad` shape and emits
 * the typed `{ artifact }` envelope (ADR 0055/0083); the chat workbench renders it as an
 * orthographic SVG projection. Constrained typed JSON (host registry does authoritative
 * AJV validation); this node does structural normalization + fail-fast. Pure-JS, Node-20.
 */

const KINDS = new Set(['box', 'cylinder', 'sphere', 'cone', 'mesh']);
// UX_UPGRADE-cad R2 (CAD2-B1) — EVERY numeric field the schema accepts and a
// consumer honours. `rotation`, `metallic` and `roughness` were missing, and
// because `openwop:cad.render` writes with `merge:'replace'`, the agent's own
// documented flow — "read it with get-design … and modify the REAL current
// solids" — DESTROYED all three on every round-trip. They are first-class user
// edits (the property panel's Rotation field, the on-canvas rotate gizmo, the
// metallic/roughness sliders) and every consumer honours them: tessellation and
// `poseMesh` in `meshCodec`, GLB materials in `cadExport`, and `cadDims`, where
// an `angular` dimension IS `solid.rotation` — so a 45° bracket came back
// reading 0°. Measured before the fix: in {rotation:45, metallic:0.9,
// roughness:0.2} → out {} .
//
// Keyed off the SCHEMA, not memory: anything numeric in `artifactTypes.ts`'s
// solid properties belongs here. A field added there without being added here
// is silently dropped, which is exactly how these three were lost.
const NUM = [
  'x', 'y', 'z', 'width', 'height', 'depth', 'radius', 'length',
  'rotation', 'metallic', 'roughness',
];

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
  // ADR 0388 P5 — library material (closed-world id; AJV is the authority) +
  // safe-paint emissive.
  const materialId = str(raw.materialId, 40); if (materialId) out.materialId = materialId;
  if (typeof raw.emissive === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.emissive)) out.emissive = raw.emissive;
  // ADR 0388 P1 — a mesh solid REFERENCES a stored, content-addressed mesh
  // asset (assetRef required; optional uniform scale > 0). Never inline geometry.
  if (raw.kind === 'mesh') {
    const assetRef = str(raw.assetRef, 200);
    if (!assetRef) throw fail(`solid ${index} (mesh) requires an assetRef`);
    out.assetRef = assetRef;
    if (typeof raw.scale === 'number' && Number.isFinite(raw.scale) && raw.scale > 0) out.scale = raw.scale;
  } else if (raw.assetRef !== undefined || raw.scale !== undefined) {
    throw fail(`solid ${index}: assetRef/scale are only valid on a mesh solid`);
  }
  return out;
}

/** ctx.features.cad — the ADR 0014 surface the mesh nodes require. */
function ensureCad(ctx) {
  const cad = ctx.features && ctx.features.cad;
  if (!cad || typeof cad.meshImport !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.cad — the CAD feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.openwop-app.cad' },
    );
  }
  return cad;
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
  // ADR 0388 P3 — dimensions pass through structurally; the host registry's
  // AJV + the editor validator are the authoritative closed-world gate.
  if (Array.isArray(m.dimensions) && m.dimensions.length > 0 && m.dimensions.length <= 100) payload.dimensions = m.dimensions;
  // ADR 0388 P4 — sketch passes through structurally (AJV + validator gate;
  // SOLVING happens only via the deterministic sketch-solve host op).
  if (m.sketch && typeof m.sketch === 'object' && !Array.isArray(m.sketch)) payload.sketch = m.sketch;

  return {
    status: 'success',
    outputs: {
      solidCount: payload.solids.length,
      artifact: { artifactTypeId: 'canvas.cad', payload, ...(name ? { title: name } : {}) },
    },
  };
}

export async function meshImport(ctx) {
  const cad = ensureCad(ctx);
  const i = { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
  if (typeof i.contentBase64 !== 'string' || i.contentBase64.length === 0) {
    throw fail('`contentBase64` (canonical binary STL) is required');
  }
  const out = await cad.meshImport({
    contentBase64: i.contentBase64,
    name: i.name,
    sourceFormat: i.sourceFormat,
    dropped: i.dropped,
  });
  const title = str(i.name, 200);
  return {
    status: 'success',
    outputs: {
      mesh: out.mesh,
      deduped: out.deduped === true,
      payload: out.payload,
      artifact: { artifactTypeId: 'canvas.cad', payload: out.payload, ...(title ? { title } : {}) },
    },
  };
}

export async function meshExport(ctx) {
  const cad = ensureCad(ctx);
  const i = { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
  const model = (i.model && typeof i.model === 'object') ? i.model : safeParse(i.source);
  if (!model) throw fail('`model` (a canvas.cad payload) is required');
  const out = await cad.meshExport({ model, format: i.format });
  return { status: 'success', outputs: { ...out } };
}

export async function bomGenerate(ctx) {
  const cad = ensureCad(ctx);
  const i = { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
  const model = (i.model && typeof i.model === 'object') ? i.model : safeParse(i.source);
  if (!model) throw fail('`model` (a canvas.cad payload) is required');
  const out = await cad.bomGenerate({ model });
  return { status: 'success', outputs: { bom: out.bom, csv: out.csv, artifact: out.artifact } };
}

export async function dimensionSuggest(ctx) {
  const cad = ensureCad(ctx);
  const i = { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
  const model = (i.model && typeof i.model === 'object') ? i.model : safeParse(i.source);
  if (!model) throw fail('`model` (a canvas.cad payload) is required');
  const out = await cad.dimensionSuggest({ model });
  return { status: 'success', outputs: { dimensions: out.dimensions } };
}

export async function sketchSolve(ctx) {
  const cad = ensureCad(ctx);
  const i = { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
  const sketch = (i.sketch && typeof i.sketch === 'object') ? i.sketch : safeParse(i.source);
  if (!sketch) throw fail('`sketch` ({ points, segments, constraints }) is required');
  const out = await cad.sketchSolve({ sketch });
  return { status: 'success', outputs: { ...out } };
}

export async function materialRecommend(ctx) {
  const cad = ensureCad(ctx);
  const i = { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
  const model = (i.model && typeof i.model === 'object') ? i.model : safeParse(i.source);
  if (!model) throw fail('`model` (a canvas.cad payload) is required');
  const out = await cad.materialRecommend({ model });
  return { status: 'success', outputs: { suggestions: out.suggestions, library: out.library } };
}

export const nodes = {
  'feature.cad.nodes.render': render,
  'feature.cad.nodes.mesh-import': meshImport,
  'feature.cad.nodes.mesh-export': meshExport,
  'feature.cad.nodes.bom-generate': bomGenerate,
  'feature.cad.nodes.dimension-suggest': dimensionSuggest,
  'feature.cad.nodes.sketch-solve': sketchSolve,
  'feature.cad.nodes.material-recommend': materialRecommend,
};
