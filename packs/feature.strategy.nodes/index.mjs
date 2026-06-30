/**
 * feature.strategy.nodes — Strategy nodes over the `ctx.features.strategy` surface
 * (ADR 0080 / ADR 0079 / ADR 0014). Read nodes (list/get/context/health) expose the
 * portfolio + its health; `create-board-memo` persists an AGENT-AUTHORED memo as a
 * Document via `ctx.features.documents` — the strategy surface stays READ-ONLY (the
 * write lands in Documents, never in Strategy; ADR 0080 §read-only decision).
 *
 * Every node is role:"action" so the engine records the output and replay/fork read
 * the recorded result rather than re-issuing. Pure-JS, Node-20 stdlib only.
 */

/** Resolve the Strategy feature surface, or fail with the canonical capability
 *  error (the surface is gated by the `strategy` toggle). */
function ensureStrategy(ctx) {
  const sf = ctx.features && ctx.features.strategy;
  if (!sf || typeof sf.listStrategies !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.strategy — the Strategy feature must be composed and enabled (ADR 0079)'),
      { code: 'host_capability_missing', capability: 'host.sample.strategy' },
    );
  }
  return sf;
}

const str = (v) => (typeof v === 'string' ? v : '');
const optStr = (v) => (typeof v === 'string' && v.length > 0 ? v : undefined);

export async function listStrategies(ctx) {
  const sf = ensureStrategy(ctx);
  const out = await sf.listStrategies({});
  return { status: 'success', outputs: { strategies: out.strategies ?? [] } };
}

export async function getStrategy(ctx) {
  const sf = ensureStrategy(ctx);
  const out = await sf.getStrategy({ id: str((ctx.inputs ?? {}).id) });
  return { status: 'success', outputs: { strategy: out.strategy ?? null } };
}

export async function getContext(ctx) {
  const sf = ensureStrategy(ctx);
  const i = ctx.inputs ?? {};
  const out = await sf.getStrategyContext({
    ...(optStr(i.projectId) ? { projectId: optStr(i.projectId) } : {}),
    ...(optStr(i.priorityListId) ? { priorityListId: optStr(i.priorityListId) } : {}),
    ...(optStr(i.cardId) ? { cardId: optStr(i.cardId) } : {}),
    ...(optStr(i.boardId) ? { boardId: optStr(i.boardId) } : {}),
  });
  return { status: 'success', outputs: { strategies: out.strategies ?? [] } };
}

export async function getHealth(ctx) {
  const sf = ensureStrategy(ctx);
  const out = await sf.getHealth({});
  return { status: 'success', outputs: { strategies: out.strategies ?? [] } };
}

/**
 * Persist an agent-authored board memo as a Document (kind `board-update`). The
 * markdown is authored by the caller (the Strategy Analyst writes the prose); this
 * node is a deterministic persist op. Degrades to returning the markdown inline when
 * `documents` is OFF (the priority-matrix generate-agenda degrade precedent).
 */
export async function createBoardMemo(ctx) {
  const i = ctx.inputs ?? {};
  const orgId = str(i.orgId);
  const title = str(i.title) || 'Board update';
  const markdown = str(i.markdown);
  if (!orgId || !markdown) {
    return { status: 'error', error: { code: 'validation_error', message: 'create-board-memo requires `orgId` and non-empty `markdown`.' } };
  }
  const docs = ctx.features && ctx.features.documents;
  // Documents OFF (or not composed) ⇒ degrade: return the memo inline, no persist.
  if (!docs || typeof docs.createDocument !== 'function') {
    return { status: 'success', outputs: { persisted: false, markdown, ...(optStr(i.strategyId) ? { strategyId: optStr(i.strategyId) } : {}) } };
  }
  try {
    const { document } = await docs.createDocument({ orgId, title, kind: 'board-update', format: 'markdown' });
    const { version } = await docs.addVersion({
      orgId, documentId: document.documentId, content: markdown,
      idempotencyKey: `strategy-board-memo:${str(i.strategyId)}:${document.documentId}`,
    });
    return { status: 'success', outputs: { persisted: true, documentId: document.documentId, version, ...(optStr(i.strategyId) ? { strategyId: optStr(i.strategyId) } : {}) } };
  } catch (err) {
    // Documents enabled but the write failed (e.g. toggle flipped mid-run) ⇒ degrade.
    return { status: 'success', outputs: { persisted: false, markdown, error: String(err && err.message ? err.message : err) } };
  }
}

export const nodes = {
  'feature.strategy.nodes.list-strategies': listStrategies,
  'feature.strategy.nodes.get-strategy': getStrategy,
  'feature.strategy.nodes.get-context': getContext,
  'feature.strategy.nodes.get-health': getHealth,
  'feature.strategy.nodes.create-board-memo': createBoardMemo,
};

export default nodes;
