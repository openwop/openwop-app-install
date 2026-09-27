/**
 * feature.docs.nodes — READ-ONLY docs nodes over the `ctx.features.docs` surface
 * (ADR 0392 Phase 3), backing the docs.search / docs.get MCP tools. role:"action"
 * so the engine records output → replay/fork read the recorded result. The nodes
 * NEVER touch the KB store directly — they read the scope-bound surface (the
 * notebooks/marketplace precedent). Pure-JS, Node-20 stdlib only.
 */

/** Resolve the docs feature surface, or fail with the canonical error. */
function ensureDocs(ctx) {
  const docs = ctx.features && ctx.features.docs;
  if (!docs || typeof docs.search !== 'function' || typeof docs.get !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.docs — the docs feature must be composed + enabled (ADR 0392)'),
      { code: 'host_capability_missing', capability: 'host.sample.docs' },
    );
  }
  return docs;
}

export async function search(ctx) {
  const docs = ensureDocs(ctx);
  const i = ctx.inputs ?? {};
  const query = typeof i.query === 'string' ? i.query : '';
  const limit = typeof i.limit === 'number' ? i.limit : (typeof i.limit === 'string' && i.limit ? Number(i.limit) : undefined);
  const out = await docs.search({ query, ...(Number.isFinite(limit) ? { limit } : {}) });
  const hits = Array.isArray(out.hits) ? out.hits : [];
  return { status: 'success', outputs: { hits, total: hits.length } };
}

export async function get(ctx) {
  const docs = ensureDocs(ctx);
  const i = ctx.inputs ?? {};
  const slug = typeof i.slug === 'string' ? i.slug : '';
  const out = await docs.get({ slug });
  return { status: 'success', outputs: { doc: out.doc ?? null } };
}

export const nodes = {
  'feature.docs.nodes.search': search,
  'feature.docs.nodes.get': get,
};

export default nodes;
