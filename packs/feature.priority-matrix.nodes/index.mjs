/**
 * feature.priority-matrix.nodes — Priority Matrix nodes over the
 * `ctx.features['priority-matrix']` surface (ADR 0058 / ADR 0014). Every node is
 * role:"action" (it reads or writes the tenant priority-matrix stores, a
 * side-effect), so the engine records the output and replay/fork read the recorded
 * result rather than re-issuing. Pure-JS, Node-20 stdlib only.
 */

/** Resolve the Priority Matrix feature surface, or fail with the canonical
 *  capability error (the surface is gated by the `priority-matrix` toggle). */
function ensurePriorityMatrix(ctx) {
  const pm = ctx.features && ctx.features['priority-matrix'];
  if (!pm || typeof pm.listLists !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['priority-matrix'] — the Priority Matrix feature must be composed and enabled (ADR 0058)"),
      { code: 'host_capability_missing', capability: 'host.sample.priority-matrix' },
    );
  }
  return pm;
}

const str = (v) => (typeof v === 'string' ? v : '');

export async function listLists(ctx) {
  const pm = ensurePriorityMatrix(ctx);
  const out = await pm.listLists({});
  return { status: 'success', outputs: { lists: out.lists ?? [] } };
}

export async function listRankedIdeas(ctx) {
  const pm = ensurePriorityMatrix(ctx);
  const out = await pm.listRankedIdeas({ listId: str((ctx.inputs ?? {}).listId) });
  return { status: 'success', outputs: { ideas: out.ideas ?? [] } };
}

export async function submitIdea(ctx) {
  const pm = ensurePriorityMatrix(ctx);
  const i = ctx.inputs ?? {};
  const out = await pm.submitIdea({
    listId: str(i.listId),
    title: str(i.title),
    ...(str(i.description) ? { description: str(i.description) } : {}),
  });
  return { status: 'success', outputs: out };
}

export async function scoreIdea(ctx) {
  const pm = ensurePriorityMatrix(ctx);
  const i = ctx.inputs ?? {};
  const scores = i.scores && typeof i.scores === 'object' ? i.scores : {};
  const out = await pm.scoreIdea({ listId: str(i.listId), cardId: str(i.cardId), scores });
  return { status: 'success', outputs: out };
}

export async function generateAgenda(ctx) {
  const pm = ensurePriorityMatrix(ctx);
  const i = ctx.inputs ?? {};
  const out = await pm.generateAgenda({
    listId: str(i.listId),
    ...(str(i.name) ? { name: str(i.name) } : {}),
    ...(typeof i.n === 'number' ? { n: i.n } : {}),
  });
  return { status: 'success', outputs: out };
}

export async function scheduleStatus(ctx) {
  const pm = ensurePriorityMatrix(ctx);
  const out = await pm.getScheduleStatus({ listId: str((ctx.inputs ?? {}).listId) });
  return { status: 'success', outputs: { ideas: out.ideas ?? [], rollup: out.rollup ?? null } };
}

export async function listPortfolio(ctx) {
  const pm = ensurePriorityMatrix(ctx);
  const i = ctx.inputs ?? {};
  const out = await pm.listPortfolio({ ...(typeof i.topN === 'number' ? { topN: i.topN } : {}) });
  return { status: 'success', outputs: { items: out.items ?? [] } };
}

export const nodes = {
  'feature.priority-matrix.nodes.list-lists': listLists,
  'feature.priority-matrix.nodes.list-portfolio': listPortfolio,
  'feature.priority-matrix.nodes.list-ranked-ideas': listRankedIdeas,
  'feature.priority-matrix.nodes.submit-idea': submitIdea,
  'feature.priority-matrix.nodes.score-idea': scoreIdea,
  'feature.priority-matrix.nodes.generate-agenda': generateAgenda,
  'feature.priority-matrix.nodes.schedule-status': scheduleStatus,
};

export default nodes;
