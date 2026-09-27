/**
 * feature.work-selection.nodes — ADR 0534 P4.
 *
 * One node, role:"action" so the engine records the output (replay/fork read the
 * recorded result rather than re-ranking against a board that has since changed —
 * the same determinism rule as the ADR 0534 D3 run stamp).
 *
 * READ-ONLY: there is deliberately no node that reorders the queue or starts a
 * card. A workflow that could promote its own work would bypass the agent-policy
 * verdict and the run budget.
 *
 * Pure-JS, Node-20 stdlib only. Composes ctx.features['work-selection'] (ADR 0014).
 */

function ensureWorkSelection(ctx) {
  const ws = ctx.features && ctx.features['work-selection'];
  if (!ws || typeof ws.preview !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['work-selection'] — the Ranked work selection feature must be enabled (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.work-selection' },
    );
  }
  return ws;
}

function str(v) { return typeof v === 'string' ? v : ''; }

export async function preview(ctx) {
  const ws = ensureWorkSelection(ctx);
  const i = ctx.inputs ?? {};
  const out = await ws.preview({ boardId: str(i.boardId) });
  const ranked = Array.isArray(out.ranked) ? out.ranked : [];
  return { status: 'success', outputs: { ranked, count: ranked.length } };
}

export const nodes = {
  'feature.work-selection.nodes.preview': preview,
};

export default nodes;
