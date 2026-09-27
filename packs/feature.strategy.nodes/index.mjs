/**
 * feature.strategy.nodes — Strategy nodes over the `ctx.features.strategy` surface
 * (ADR 0080 / ADR 0079 / ADR 0014). Read nodes (list/get/context/health) expose the
 * portfolio + its health; `create-board-memo` persists an AGENT-AUTHORED memo as a
 * Document via `ctx.features.documents` — the strategy surface stays READ-ONLY (the
 * write lands in Documents, never in Strategy; ADR 0080 §read-only decision).
 *
 * REPLAY CLASSIFICATION (ADR 0676 D1/D4 — this docblock used to get it backwards).
 * It previously read: "Every node is role:\"action\" so the engine records the output and
 * replay/fork read the recorded result rather than re-issuing." That inference is FALSE and
 * it is what hid the defect ADR 0676 D1 fixes. What binds the host is
 * `gen-side-effect-floor.mjs:139` — `role === 'side-effect' OR capabilities includes
 * 'side-effectful'` — a disjunction. `role:"side-effect"` WOULD earn the guarantee;
 * `role:"action"` earns nothing (no comparison against that string exists under
 * `src/executor/` — the ADR 0587 finding). The four WRITE verbs therefore declare
 * `capabilities:["side-effectful"]` explicitly: `check-in`, `record-decision`,
 * `sync-metrics` and — added by ADR 0676 D1, having shipped unclassified while its three
 * siblings were classified — `create-board-memo`. The six read verbs declare neither.
 * Node-20 stdlib only.
 */
import { createHash } from 'node:crypto';

/** Deterministic idempotency base for a document write (ADR 0676 D1).
 *  MUST NOT depend on runId: `createDraftDocument` defaults its base to the runId
 *  (`features/documents/surface.ts:79`), which a `:fork` CHANGES — so the default would
 *  mint a second document on every fork, which is the defect this replaces. Derived from
 *  the content instead, so the same memo re-resolves to the same document id. */
function idemBaseFor(kind, orgId, title, markdown) {
  const digest = createHash('sha256').update(`${orgId}\u0000${title}\u0000${markdown}`).digest('hex').slice(0, 32);
  return `strategy-${kind}:${digest}`;
}

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
  const cfg = ctx.config ?? {};
  // STRAT-A1 — chain params ride CONFIG, so `orgId`/`title` resolve from config and
  // `markdown` arrives via an edge from the upstream AI node (content field); inputs win
  // when both are present. CORRECTED (ADR 0676 D4): this used to say static node `inputs`
  // are "stripped by the executor". They are NOT — `executor.ts:701-702` resolves declared
  // `node.inputs` and MERGES them (`nodeCtxInputs.ts:104`, fixture-wins, pinned by
  // `strategy-chain-execution.test.ts:418`).
  const orgId = str(i.orgId) || str(cfg.orgId);
  const title = str(i.title) || str(cfg.title) || 'Board update';
  const markdown = str(i.markdown) || str(i.content);
  if (!orgId || !markdown) {
    return { status: 'error', error: { code: 'validation_error', message: 'create-board-memo requires `orgId` (config or input) and non-empty `markdown`.' } };
  }
  const docs = ctx.features && ctx.features.documents;
  // Documents OFF (or not composed) ⇒ degrade: return the memo inline, no persist.
  // This arm stays `success` deliberately — nothing was attempted, so nothing failed.
  if (!docs || typeof docs.createDraftDocument !== 'function') {
    return { status: 'success', outputs: { persisted: false, markdown, ...(optStr(i.strategyId) ? { strategyId: optStr(i.strategyId) } : {}) } };
  }
  try {
    // ADR 0676 D1 — route through the ADR 0166 owner (`createDraftDocument`) rather than
    // hand-rolling createDocument + addVersion. The owner mints a DETERMINISTIC documentId
    // from `idemBase`, which is the only place a duplicate can actually be prevented:
    // `addVersion`'s idempotency lookup is scoped to `listVersions(tenant, org, documentId)`
    // (`documentsService.ts:481-485`), so on a freshly-minted document it searches an EMPTY
    // list and no key can ever match. The old key here embedded `document.documentId` from
    // the line above — unique by construction, decorative in effect.
    const res = await docs.createDraftDocument({
      orgId, title, kind: 'board-update', content: markdown,
      idemBase: idemBaseFor('board-memo', orgId, title, markdown),
    });
    if (res && res.error) {
      return { status: 'error', error: { code: res.error.code || 'document_write_failed', message: res.error.message || 'create-board-memo could not persist the memo.' } };
    }
    return { status: 'success', outputs: { persisted: true, documentId: res.document.documentId, version: res.version, ...(optStr(i.strategyId) ? { strategyId: optStr(i.strategyId) } : {}) } };
  } catch (err) {
    // ADR 0676 D1 / `SPC-20` — a write that was ATTEMPTED and FAILED is a typed failure,
    // never success-with-a-note. The old arm returned `status:'success'` carrying the
    // error, which makes "the document count stayed 1" pass for the wrong reason and is
    // the success-with-empty family this repo polices.
    return { status: 'error', error: { code: 'document_write_failed', message: String(err && err.message ? err.message : err) } };
  }
}

/**
 * ADR 0231 — the measurement loop. `check-in` is STRUCTURALLY a proposal from a
 * run (`origin:'agent'` ⇒ status `proposed`; a human confirms in the app). The
 * capability firewall cannot see node calls (adsAdapter.ts:204), so the gate
 * lives in the surface/service owner — this node cannot escalate.
 */
export async function checkIn(ctx) {
  const sf = ensureStrategy(ctx);
  const i = ctx.inputs ?? {};
  const value = typeof i.value === 'number' ? i.value : (i.value !== undefined && i.value !== null && i.value !== '' ? Number(i.value) : undefined);
  const out = await sf.checkIn({
    strategyId: str(i.strategyId),
    krId: str(i.krId),
    ...(value !== undefined && Number.isFinite(value) ? { value } : {}),
    ...(optStr(i.note) ? { note: optStr(i.note) } : {}),
    // mode 'sync' is reserved for the metric-sync chain; agents propose.
    ...(optStr(i.mode) === 'sync' ? { mode: 'sync' } : {}),
    ...(ctx.runId ? { actor: `run:${ctx.runId}` } : {}),
  });
  return { status: 'success', outputs: { checkIn: out.checkIn ?? null } };
}

export async function listCheckIns(ctx) {
  const sf = ensureStrategy(ctx);
  const i = ctx.inputs ?? {};
  const out = await sf.listCheckIns({ strategyId: str(i.strategyId), ...(optStr(i.krId) ? { krId: optStr(i.krId) } : {}) });
  return { status: 'success', outputs: { checkIns: out.checkIns ?? [] } };
}

/** The cadence chain's work list (ADR 0231 §C2): measured KRs with no confirmed
 *  check-in inside the staleness window, across ACTIVE shared strategies. */
export async function listStaleKrs(ctx) {
  const sf = ensureStrategy(ctx);
  const i = ctx.inputs ?? {};
  const staleDays = typeof i.staleDays === 'number' ? i.staleDays : undefined;
  const out = await sf.listStaleKrs(staleDays !== undefined ? { staleDays } : {});
  return { status: 'success', outputs: { staleKrs: out.staleKrs ?? [] } };
}

/** ADR 0231 §C3 — sync sourced KRs from their configured data owners. Returns
 *  the honest synced/skipped matrix (the run output IS the sync-health view). */
export async function syncMetrics(ctx) {
  const sf = ensureStrategy(ctx);
  if (typeof sf.syncMetrics !== 'function') {
    return { status: 'error', error: { code: 'host_capability_missing', message: 'ctx.features.strategy.syncMetrics is not exposed on this host (ADR 0231).' } };
  }
  const out = await sf.syncMetrics({ ...(ctx.runId ? { actor: `run:${ctx.runId}` } : {}) });
  return { status: 'success', outputs: { synced: out.synced ?? [], skipped: out.skipped ?? [] } };
}

/**
 * ADR 0233 §C8 — the agent-drafting half of decision records: persists a
 * `decision-record` Document ONLY (no strategy link — links are canonical
 * human writes; a human links it via POST /strategy/:id/decisions or the
 * alignment editor). Mirrors create-board-memo's degrade posture.
 */
export async function recordDecision(ctx) {
  const i = ctx.inputs ?? {};
  const orgId = str(i.orgId);
  const title = str(i.title) || 'Decision';
  const markdown = str(i.markdown);
  if (!orgId || !markdown) {
    return { status: 'error', error: { code: 'validation_error', message: 'record-decision requires `orgId` and non-empty `markdown`.' } };
  }
  const docs = ctx.features && ctx.features.documents;
  if (!docs || typeof docs.createDraftDocument !== 'function') {
    return { status: 'success', outputs: { persisted: false, markdown } };
  }
  try {
    // ADR 0676 D1 — the SAME defect as create-board-memo, byte-identical, 80 lines away.
    // Fixed together: filing the instance and not the class is how the twin survives.
    const decisionTitle = `Decision — ${title}`;
    const res = await docs.createDraftDocument({
      orgId, title: decisionTitle, kind: 'decision-record', content: markdown,
      idemBase: idemBaseFor('decision', orgId, decisionTitle, markdown),
    });
    if (res && res.error) {
      return { status: 'error', error: { code: res.error.code || 'document_write_failed', message: res.error.message || 'record-decision could not persist the decision record.' } };
    }
    return { status: 'success', outputs: { persisted: true, documentId: res.document.documentId, version: res.version } };
  } catch (err) {
    return { status: 'error', error: { code: 'document_write_failed', message: String(err && err.message ? err.message : err) } };
  }
}

export const nodes = {
  'feature.strategy.nodes.list-strategies': listStrategies,
  'feature.strategy.nodes.get-strategy': getStrategy,
  'feature.strategy.nodes.get-context': getContext,
  'feature.strategy.nodes.get-health': getHealth,
  'feature.strategy.nodes.create-board-memo': createBoardMemo,
  'feature.strategy.nodes.check-in': checkIn,
  'feature.strategy.nodes.list-check-ins': listCheckIns,
  'feature.strategy.nodes.list-stale-krs': listStaleKrs,
  'feature.strategy.nodes.sync-metrics': syncMetrics,
  'feature.strategy.nodes.record-decision': recordDecision,
};

export default nodes;
