/**
 * feature.agent-knowledge.nodes — Agent-knowledge feature nodes over the
 * `ctx.features.agentKnowledge` surface (ADR 0038 / ADR 0014 Phase 2).
 *
 * `retrieve` is `role: "action"` and read-only. `ingest` is `role: "side-effect"`
 * with the `side-effectful` capability, which is what the derived floor + the
 * fast-path-served set are generated from.
 *
 * CORRECTION 2026-08-19 (WF-AKM-1 / ADR 0587 §7). This docblock used to say both
 * nodes were `role: "action"` and that therefore "the engine records each output
 * and replay/fork read the recorded result rather than re-executing — so `ingest`
 * never double-writes". **Every clause of that was false.**
 * `git grep "role === 'action'" -- src/executor/` returns ZERO lines: the executor
 * never reads `role` at all; only the generator does, and it reads `side-effect`.
 * `ingest` was in NONE of `MANIFEST_SIDE_EFFECT_FLOOR`, `MANIFEST_FAST_PATH_SERVED`
 * or `SIDE_EFFECTING_TYPE_PATTERNS`, and no `assertEffectAllowed` seam covered the
 * KB write, so a `:fork` in `replay` mode ran `replayServed ?? module.execute(ctx)`
 * with `replayServed === undefined` and wrote a SECOND document. Both #2871 legs
 * are now present: the manifest declaration here AND an explicit typeId entry in
 * `executor/sideEffects.ts` — a pack `.mjs` node cannot set `module.sideEffecting`,
 * so neither leg substitutes for the other.
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
  // `failedSources` (KB-UX-3 / ADR 0583) — the sources that could not be
  // searched at all. Surfaced, not swallowed: without it a faulted KB backend
  // reaches this node's consumer (often a MODEL) as `hasResults:false`, which is
  // byte-identical to an empty corpus, and the honest answer "part of your
  // knowledge could not be searched" becomes the false "there is nothing there".
  // Always an array; `[]` on the happy path.
  const failedSources = Array.isArray(out.failedSources) ? out.failedSources : [];
  // WF-AKM-3 — `unavailable` names WHY there is no corpus: 'capability-off' (a
  // named reason) vs 'nothing-bound' (a genuinely empty corpus). A non-existent
  // agent is a typed failure and throws before reaching here. Without this the
  // node emitted `hasResults:false` for all three and a MODEL read a fabricated
  // "your knowledge base is empty".
  const unavailable = typeof out.unavailable === 'string' ? out.unavailable : undefined;
  return {
    status: 'success',
    outputs: {
      chunks: out.chunks ?? [],
      hasResults: out.hasResults ?? false,
      failedSources,
      ...(unavailable ? { unavailable } : {}),
    },
  };
}

export async function ingest(ctx) {
  const ak = ensureAgentKnowledge(ctx, 'ingestDocument');
  const inputs = ctx.inputs && typeof ctx.inputs === 'object' ? ctx.inputs : {};
  // Trigger-started runs carry the event in ctx.triggerData (inputs is null) — pull
  // the doc fields from the webhook/email/form payload when no inputs were wired.
  const td = ctx.triggerData && typeof ctx.triggerData === 'object' ? ctx.triggerData : {};
  const trig = (td.webhook && td.webhook.body) || td.form || td.email || {};
  const readTrigger = Object.keys(inputs).length === 0 && trig && typeof trig === 'object' && Object.keys(trig).length > 0;
  const src = readTrigger ? trig : inputs;
  const pick = (k) => (typeof src[k] === 'string' ? src[k] : '');
  // WF-AKM-2 (ADR 0587 §1) — TRUST IS A PROPERTY OF THE RUN, NOT OF THE SHAPE OF
  // `ctx.inputs`. This used to be decided by `Object.keys(inputs).length === 0`,
  // i.e. "the node received no inputs". That is accidentally right only for the
  // shipped one-node chain: this chain is advertised as BUILDER-EDITABLE, and
  // adding a single upstream node that carries the webhook body into `ingest.text`
  // makes `inputs` non-empty ⇒ the payload was relabelled `'trusted'`. That label
  // is load-bearing: `agentDispatch` puts `contentTrust !== 'untrusted'` in the
  // cited, quotable block and only `'untrusted'` reaches `fenceUntrustedItems`, so
  // the mislabel laundered external content past the RFC 0021 fence this node's
  // own comment exists to enforce.
  //
  // `ctx.trustBoundary` is stamped from `run.metadata.trustBoundary` at run start
  // (trigger ignition sets `'untrusted'`) and is constant across the run, so it
  // survives any chain edit. `readTrigger` is kept as a second OR-arm — defence in
  // depth for a host that never stamped the boundary — and the caller-supplied
  // value is closed-world validated instead of passed through as any string.
  const runUntrusted = ctx.trustBoundary === 'untrusted' || readTrigger;
  const declared = src.contentTrust === 'untrusted' || src.contentTrust === 'trusted' ? src.contentTrust : 'trusted';
  const out = await ak.ingestDocument({
    agentId: pick('agentId'),
    collectionId: pick('collectionId'),
    title: pick('title'),
    text: pick('text'),
    // Monotone downgrade: an untrusted run can never produce trusted knowledge,
    // whatever the caller declares.
    contentTrust: runUntrusted ? 'untrusted' : declared,
  });
  return { status: 'success', outputs: { documentId: out.documentId ?? '', chunkCount: out.chunkCount ?? 0 } };
}

export const nodes = {
  'feature.agent-knowledge.nodes.retrieve': retrieve,
  'feature.agent-knowledge.nodes.ingest': ingest,
};

export default nodes;
