/**
 * feature.computer-use.nodes — the ADR 0418 browser-agent verbs over
 * ctx.features['computer-use']. The chain shape: `task` starts/resumes a
 * session and runs until completion OR a commit-tier action halts it
 * (`awaiting_approval`) → compose `core.approvalGate` → `decide` records the
 * human verdict and resumes. All role:action (recorded) — replay reads the
 * recorded trajectory and never re-drives a browser.
 */
function ensure(ctx, method) {
  const s = ctx.features && ctx.features['computer-use'];
  if (!s || typeof s[method] !== 'function') {
    throw Object.assign(
      new Error(`host does not expose ctx.features['computer-use'].${method} — the feature must be composed (ADR 0014)`),
      { code: 'host_capability_missing', capability: 'host.sample.computer-use' },
    );
  }
  return s;
}
function str(v) { return typeof v === 'string' ? v : ''; }

export async function task(ctx) {
  const cu = ensure(ctx, 'startTask');
  const i = ctx.inputs ?? {};
  const out = await cu.startTask({
    orgId: str(i.orgId),
    task: str(i.task),
    startUrl: str(i.startUrl),
    allowedOrigins: Array.isArray(i.allowedOrigins) ? i.allowedOrigins : [],
    // ADR 0541 D2 / WF-JS-2 — forward the apply-grant context. This was READ by
    // the surface (closed-world normalised there) and FORWARDED by nothing: the
    // career.apply chain's `applyContext` param silently vanished here, so the
    // commit gate could never consult a grant for a chain-driven session — the
    // exact "reachability was not proven" defect StartTaskInput's own docblock
    // records, reintroduced one layer up. Pinned by career-apply-chain-gate.test.ts.
    applyContext: i.applyContext,
  });
  return { status: 'success', outputs: out };
}

export async function decide(ctx) {
  const cu = ensure(ctx, 'decide');
  const i = ctx.inputs ?? {};
  const out = await cu.decide({ sessionId: str(i.sessionId), approve: i.approve === true });
  return { status: 'success', outputs: out };
}

export async function status(ctx) {
  const cu = ensure(ctx, 'status');
  const i = ctx.inputs ?? {};
  const out = await cu.status({ sessionId: str(i.sessionId) });
  return { status: 'success', outputs: out };
}

export const nodes = {
  'feature.computer-use.nodes.task': task,
  'feature.computer-use.nodes.decide': decide,
  'feature.computer-use.nodes.status': status,
};
export default nodes;
