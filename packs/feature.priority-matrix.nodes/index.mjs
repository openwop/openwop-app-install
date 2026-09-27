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
    // ADR 0246 — when supplied (the forms→intake bridge), the surface asserts
    // the target list belongs to this org (write-boundary org guard).
    ...(str(i.orgId) ? { orgId: str(i.orgId) } : {}),
    // ADR 0247 OQ-5 — the originating form submission; the surface stamps it +
    // sourceChannel:'form' on the new idea's intake overlay for provenance.
    ...(str(i.sourceSubmissionId) ? { sourceSubmissionId: str(i.sourceSubmissionId) } : {}),
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


/**
 * ADR 0235 §D1 — PROPOSE a what-if scenario on a planning session (stamped
 * proposedBy:'agent'). A scenario is inert until a HUMAN selects it as plan of
 * record — structurally proposal-safe (node calls bypass the capability
 * firewall; the gate lives in the owning surface).
 */
export async function proposeScenario(ctx) {
  const pm = ensurePriorityMatrix(ctx);
  if (typeof pm.proposeScenario !== 'function') {
    return { status: 'error', error: { code: 'host_capability_missing', message: 'ctx.features[priority-matrix].proposeScenario is not exposed on this host (ADR 0235).' } };
  }
  const i = ctx.inputs ?? {};
  const out = await pm.proposeScenario({
    listId: str(i.listId),
    sessionId: str(i.sessionId),
    name: i.name,
    selection: i.selection,
    ...(i.constraints !== undefined ? { constraints: i.constraints } : {}),
    ...(ctx.runId ? { actor: `run:${ctx.runId}` } : {}),
  });
  return { status: 'success', outputs: { scenario: out.scenario ?? null } };
}

/**
 * ADR 0232 §7 (STRAT-PM1) — intake node verbs. Read + fields/evidence writes,
 * the same content-metadata class as `submit-idea`. Promotion is deliberately
 * absent (it creates work containers = authority-granting; stays human/route).
 */
export async function getIntake(ctx) {
  const pm = ensurePriorityMatrix(ctx);
  if (typeof pm.getIntake !== 'function') {
    return { status: 'error', error: { code: 'host_capability_missing', message: "ctx.features['priority-matrix'].getIntake is not exposed on this host (ADR 0232)." } };
  }
  const i = ctx.inputs ?? {};
  const out = await pm.getIntake({ listId: str(i.listId), cardId: str(i.cardId) });
  return { status: 'success', outputs: { intake: out.intake ?? null, evidence: out.evidence ?? [] } };
}

export async function updateIntake(ctx) {
  const pm = ensurePriorityMatrix(ctx);
  if (typeof pm.updateIntake !== 'function') {
    return { status: 'error', error: { code: 'host_capability_missing', message: "ctx.features['priority-matrix'].updateIntake is not exposed on this host (ADR 0232)." } };
  }
  const i = ctx.inputs ?? {};
  const patch = {};
  for (const k of ['requester', 'sourceChannel', 'estimatedValue', 'estimatedValueUnit', 'notes', 'sourceSubmissionId']) {
    if (i[k] !== undefined) patch[k] = i[k];
  }
  const out = await pm.updateIntake({ listId: str(i.listId), cardId: str(i.cardId), patch, ...(ctx.runId ? { actor: `run:${ctx.runId}` } : {}) });
  return { status: 'success', outputs: { intake: out.intake ?? null } };
}

export async function addEvidence(ctx) {
  const pm = ensurePriorityMatrix(ctx);
  if (typeof pm.addEvidence !== 'function') {
    return { status: 'error', error: { code: 'host_capability_missing', message: "ctx.features['priority-matrix'].addEvidence is not exposed on this host (ADR 0232)." } };
  }
  const i = ctx.inputs ?? {};
  const out = await pm.addEvidence({
    listId: str(i.listId), cardId: str(i.cardId), kind: str(i.kind), ref: str(i.ref),
    ...(str(i.label) ? { label: str(i.label) } : {}),
    ...(ctx.runId ? { actor: `run:${ctx.runId}` } : {}),
  });
  return { status: 'success', outputs: { evidence: out.evidence ?? null } };
}

export const nodes = {
  'feature.priority-matrix.nodes.list-lists': listLists,
  'feature.priority-matrix.nodes.list-portfolio': listPortfolio,
  'feature.priority-matrix.nodes.list-ranked-ideas': listRankedIdeas,
  'feature.priority-matrix.nodes.submit-idea': submitIdea,
  'feature.priority-matrix.nodes.score-idea': scoreIdea,
  'feature.priority-matrix.nodes.generate-agenda': generateAgenda,
  'feature.priority-matrix.nodes.schedule-status': scheduleStatus,
  'feature.priority-matrix.nodes.propose-scenario': proposeScenario,
  'feature.priority-matrix.nodes.get-intake': getIntake,
  'feature.priority-matrix.nodes.update-intake': updateIntake,
  'feature.priority-matrix.nodes.add-evidence': addEvidence,
};

export default nodes;
