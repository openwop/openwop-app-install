/**
 * feature.accessibility.nodes — Accessibility nodes (ADR 0363 P3).
 * Both role:"action" so the engine records outputs (replay/fork read the recorded
 * result rather than re-running). Pure-JS, Node-20 stdlib only. Each node composes
 * ctx.features.accessibility (ADR 0014) — the host must have the accessibility
 * feature enabled + the surface registered.
 */

function ensureAccessibility(ctx) {
  const a = ctx.features && ctx.features.accessibility;
  if (!a || typeof a.checkContent !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.accessibility — the Accessibility feature must be enabled (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.accessibility' },
    );
  }
  return a;
}

function str(v) { return typeof v === 'string' ? v : ''; }
function arr(v) { return Array.isArray(v) ? v : []; }

export async function check(ctx) {
  const a = ensureAccessibility(ctx);
  const i = ctx.inputs ?? {};
  const out = await a.checkContent({
    images: arr(i.images),
    headings: arr(i.headings),
    links: arr(i.links),
    colorPairs: arr(i.colorPairs),
  });
  const issues = Array.isArray(out.issues) ? out.issues : [];
  return { status: 'success', outputs: { issues, count: issues.length } };
}

export async function altTextGenerate(ctx) {
  const a = ensureAccessibility(ctx);
  const i = ctx.inputs ?? {};
  const out = await a.generateAltText({ orgId: str(i.orgId), assetId: str(i.assetId) });
  return { status: 'success', outputs: { assetId: out.assetId, altText: out.altText } };
}

export const nodes = {
  'feature.accessibility.nodes.check': check,
  'feature.accessibility.nodes.alt-text-generate': altTextGenerate,
};

export default nodes;
