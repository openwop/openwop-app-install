/**
 * feature.advisory-board.nodes — Board of Advisors read node over the
 * `ctx.features['advisory-board']` surface (ADR 0040 / ADR 0014). role:"action"
 * (it reads the tenant board store — a side-effect), so the engine records the
 * output and replay/fork read the recorded result rather than re-querying.
 *
 * Only the cohort READ is a node. The boardroom CONVERSATION runs on the existing
 * AI chat (chat.turn, ADR 0040 § Correction 2026-06-15), never a node-side convene.
 * Node access is tenant-internal, so only `shared` boards are visible (a `private`
 * board is the creator's, not node-accessible). Pure-JS, Node-20 stdlib only.
 */

/** Resolve the Board of Advisors feature surface, or fail with the canonical
 *  capability error (the surface is gated by the `advisory-board` toggle). */
function ensureAdvisoryBoard(ctx) {
  const ab = ctx.features && ctx.features['advisory-board'];
  if (!ab || typeof ab.listBoards !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['advisory-board'] — the Board of Advisors feature must be composed and enabled (ADR 0040)"),
      { code: 'host_capability_missing', capability: 'host.sample.advisory-board' },
    );
  }
  return ab;
}

export async function listBoards(ctx) {
  const ab = ensureAdvisoryBoard(ctx);
  const out = await ab.listBoards({});
  return { status: 'success', outputs: { boards: out.boards ?? [] } };
}

export const nodes = {
  'feature.advisory-board.nodes.list-boards': listBoards,
};

export default nodes;
