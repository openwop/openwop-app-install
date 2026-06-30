/**
 * feature.kb.nodes — Knowledge Base feature nodes over the `ctx.features.kb`
 * surface (ADR 0014 Phase 2). The first node pack to call a FEATURE surface
 * (`ctx.features.<id>`), as opposed to a core host surface (`ctx.knowledge`).
 *
 * Both are `role: "action"` (they read the tenant KB store — a side-effect), so
 * the engine records their outputs in the event log and replay/fork read the
 * recorded result rather than re-querying. Pure-JS, Node-20 stdlib only.
 */

/** Resolve the KB feature surface, or fail with the canonical capability error
 *  (workflow-register should refuse a workflow needing it on a host that doesn't
 *  expose it — ADR 0014 Phase 4 gating; this is the runtime backstop). */
function ensureKb(ctx) {
  const kb = ctx.features && ctx.features.kb;
  if (!kb || typeof kb.search !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.kb — the KB feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.kb' },
    );
  }
  return kb;
}

function inputs(ctx) {
  const i = ctx.inputs ?? {};
  return {
    orgId: typeof i.orgId === 'string' ? i.orgId : '',
    collectionId: typeof i.collectionId === 'string' ? i.collectionId : '',
    query: typeof i.query === 'string' ? i.query : '',
    topK: typeof i.topK === 'number' ? i.topK : undefined,
  };
}

export async function search(ctx) {
  const kb = ensureKb(ctx);
  const { orgId, collectionId, query, topK } = inputs(ctx);
  const out = await kb.search({ orgId, collectionId, query, topK });
  return { status: 'success', outputs: { results: out.results ?? [] } };
}

export async function rag(ctx) {
  const kb = ensureKb(ctx);
  const { orgId, collectionId, query, topK } = inputs(ctx);
  const out = await kb.rag({ orgId, collectionId, query, topK });
  return {
    status: 'success',
    outputs: {
      augmentedPrompt: out.augmentedPrompt ?? '',
      citations: out.citations ?? [],
      contexts: out.contexts ?? [],
    },
  };
}

export async function listCollections(ctx) {
  const kb = ensureKb(ctx);
  const { orgId } = inputs(ctx);
  const out = await kb.listCollections({ orgId });
  return { status: 'success', outputs: { collections: out.collections ?? [] } };
}

export const nodes = {
  'feature.kb.nodes.search': search,
  'feature.kb.nodes.rag': rag,
  'feature.kb.nodes.list-collections': listCollections,
};

export default nodes;
