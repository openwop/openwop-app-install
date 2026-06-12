/**
 * feature.csm.nodes — Customer-Success nodes over the `ctx.features.csm` surface
 * (ADR 0014). Both are role:"action" (they read/write the tenant account store, a
 * side-effect), so the engine records their outputs and replay/fork read the
 * recorded result rather than re-executing. health-set is idempotent by accountId
 * (update-only — a node-driven create would be non-deterministic, so it's rejected).
 * Pure-JS, Node-20 stdlib only.
 */

/** Resolve the CSM feature surface, or fail with the canonical capability error. */
function ensureCsm(ctx) {
  const csm = ctx.features && ctx.features.csm;
  if (!csm || typeof csm.listAccounts !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.csm — the CSM feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.csm' },
    );
  }
  return csm;
}

function inputs(ctx) {
  const i = ctx.inputs ?? {};
  return {
    accountId: typeof i.accountId === 'string' ? i.accountId : '',
    name: typeof i.name === 'string' ? i.name : undefined,
    healthScore: typeof i.healthScore === 'number' ? i.healthScore : undefined,
  };
}

export async function healthRead(ctx) {
  const csm = ensureCsm(ctx);
  const { accountId } = inputs(ctx);
  if (accountId) {
    const out = await csm.getAccount({ accountId });
    return { status: 'success', outputs: { account: out.account ?? null, accounts: out.account ? [out.account] : [] } };
  }
  const out = await csm.listAccounts({});
  return { status: 'success', outputs: { accounts: out.accounts ?? [] } };
}

export async function healthSet(ctx) {
  const csm = ensureCsm(ctx);
  const { accountId, name, healthScore } = inputs(ctx);
  if (!accountId) {
    throw Object.assign(new Error('feature.csm.nodes.health-set requires `accountId` (update-only)'), { code: 'validation_error' });
  }
  const args = { accountId };
  if (name !== undefined) args.name = name;
  if (healthScore !== undefined) args.healthScore = healthScore;
  const out = await csm.setHealth(args);
  if (!out.account) {
    throw Object.assign(new Error('CSM account not found for this tenant'), { code: 'not_found' });
  }
  return { status: 'success', outputs: { account: out.account } };
}

export const nodes = {
  'feature.csm.nodes.health-read': healthRead,
  'feature.csm.nodes.health-set': healthSet,
};

export default nodes;
