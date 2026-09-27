/**
 * feature.kb.nodes — Knowledge Base feature nodes over the `ctx.features.kb`
 * surface (ADR 0014 Phase 2). The first node pack to call a FEATURE surface
 * (`ctx.features.<id>`), as opposed to a core host surface (`ctx.knowledge`).
 *
 * The three READ nodes are `role: "action"` (they read the tenant KB store — a
 * side-effect), so the engine records their outputs in the event log and
 * replay/fork read the recorded result rather than re-querying. `reindex-drain`
 * (v1.2.0, ADR 0643 D2) is `role: "side-effect"` — see its own docblock.
 * Pure-JS, Node-20 stdlib only.
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

/**
 * ADR 0643 D1b/D2 — drive ONE bounded slice of an in-progress reindex.
 *
 * `role: "side-effect"`, unlike the three reads above, and not as a formality:
 * the terminal branch of `drainReindex` flips the collection's `activeSignature`
 * and DELETES the old namespace's vectors. A `mode:'replay'` fork that
 * re-executed this would delete the namespace the collection is currently
 * serving from. The derived side-effect floor (`gen-side-effect-floor.mjs`) is
 * what makes the declaration binding.
 *
 * The node carries NO authorization of its own, and that is deliberate: a pack
 * node is data a tenant can put in any chain. The gate is STRUCTURAL, in the
 * surface — a job must already exist (only the `host:org:manage` REST door
 * creates one) and the run's workflowId must be the host-minted reindex id.
 * A refusal arrives here as a thrown error ⇒ a node FAILURE, never
 * success-with-empty.
 */
export async function reindexDrain(ctx) {
  const kb = ensureKb(ctx);
  if (typeof kb.reindexDrain !== 'function') {
    throw Object.assign(
      new Error('ctx.features.kb.reindexDrain is not exposed by this host (feature.kb.nodes >= 1.2.0 requires it)'),
      { code: 'host_capability_missing', capability: 'host.sample.kb' },
    );
  }
  const i = ctx.inputs ?? {};
  const { orgId, collectionId } = inputs(ctx);
  // A LITERAL arg object with no spread, deliberately: `pack-surface-arg-parity`
  // (ADR 0624 D2) can only assert key-for-key parity against a literal call site,
  // and a spread would move this node into the EXCLUDED population — a node that
  // silently sends a key its surface does not read is exactly the class that gate
  // exists to catch. `undefined` means "use the host default"; the surface's
  // `surfaceOptCount` treats a present-but-unusable value as a typed failure.
  const out = await kb.reindexDrain({
    orgId,
    collectionId,
    maxChunks: typeof i.maxChunks === 'number' ? i.maxChunks : undefined,
  });
  return {
    status: 'success',
    outputs: {
      status: out.status,
      embeddedChunks: out.embeddedChunks,
      totalChunks: out.totalChunks,
      done: out.done,
      ...(out.error ? { error: out.error } : {}),
    },
  };
}

export const nodes = {
  'feature.kb.nodes.search': search,
  'feature.kb.nodes.rag': rag,
  'feature.kb.nodes.list-collections': listCollections,
  'feature.kb.nodes.reindex-drain': reindexDrain,
};

export default nodes;
