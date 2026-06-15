/**
 * feature.agent-knowledge.nodes — Agent-knowledge feature nodes over the
 * `ctx.features.agentKnowledge` surface (ADR 0038 / ADR 0014 Phase 2).
 *
 * Both nodes are `role: "action"` (side-effects on the tenant stores), so the
 * engine records each output and replay/fork read the recorded result rather than
 * re-executing — so `ingest` never double-writes.
 *
 * READ-ONLY LINE (ADR 0038 §9, redrawn): the agent's MEMORY/notes namespace
 * (RFC 0004) stays read-only — these nodes NEVER write `ctx.memory`. `ingest`
 * writes only the KB-DOCUMENT side (a host-extension feature store, ADR 0011),
 * a normal feature write (no wire contract, no RFC). Pure-JS, Node-20 stdlib only.
 */

/** Resolve the agent-knowledge feature surface + assert the needed method, or
 *  fail with the canonical capability error (workflow-register should refuse a
 *  workflow needing it on a host that doesn't expose it — ADR 0014 Phase 4
 *  gating; runtime backstop). */
function ensureAgentKnowledge(ctx, method) {
  const ak = ctx.features && ctx.features['agent-knowledge'];
  if (!ak || typeof ak[method] !== 'function') {
    throw Object.assign(
      new Error(`host does not expose ctx.features.agentKnowledge.${method} — the agent-knowledge feature must be composed (ADR 0038)`),
      { code: 'host_capability_missing', capability: 'host.sample.agent-knowledge' },
    );
  }
  return ak;
}

export async function retrieve(ctx) {
  const ak = ensureAgentKnowledge(ctx, 'retrieve');
  const i = ctx.inputs ?? {};
  const agentId = typeof i.agentId === 'string' ? i.agentId : '';
  const query = typeof i.query === 'string' ? i.query : '';
  const out = await ak.retrieve({ agentId, query });
  return { status: 'success', outputs: { chunks: out.chunks ?? [], hasResults: out.hasResults ?? false } };
}

export async function ingest(ctx) {
  const ak = ensureAgentKnowledge(ctx, 'ingestDocument');
  const inputs = ctx.inputs && typeof ctx.inputs === 'object' ? ctx.inputs : {};
  // Trigger-started runs carry the event in ctx.triggerData (inputs is null) — pull
  // the doc fields from the webhook/email/form payload. Content arriving via a
  // trigger is UNTRUSTED (the run is trustBoundary:'untrusted') → stamp it so
  // dispatch FENCES it on retrieval and never injects it as agent-trusted (ADR
  // 0038 §C / RFC 0021). A direct (non-trigger) workflow invocation is trusted.
  const td = ctx.triggerData && typeof ctx.triggerData === 'object' ? ctx.triggerData : {};
  const trig = (td.webhook && td.webhook.body) || td.form || td.email || {};
  const fromTrigger = Object.keys(inputs).length === 0 && trig && typeof trig === 'object' && Object.keys(trig).length > 0;
  const src = fromTrigger ? trig : inputs;
  const pick = (k) => (typeof src[k] === 'string' ? src[k] : '');
  const out = await ak.ingestDocument({
    agentId: pick('agentId'),
    collectionId: pick('collectionId'),
    title: pick('title'),
    text: pick('text'),
    contentTrust: fromTrigger ? 'untrusted' : (typeof src.contentTrust === 'string' ? src.contentTrust : 'trusted'),
  });
  return { status: 'success', outputs: { documentId: out.documentId ?? '', chunkCount: out.chunkCount ?? 0 } };
}

export const nodes = {
  'feature.agent-knowledge.nodes.retrieve': retrieve,
  'feature.agent-knowledge.nodes.ingest': ingest,
};

export default nodes;
