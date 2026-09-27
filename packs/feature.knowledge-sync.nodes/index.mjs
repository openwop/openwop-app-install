/**
 * Knowledge-sync feature node pack (WF-KB-3 / KSWF-1) — one role:"action" node
 * that runs one scheduled sync pass for a SyncSource through the
 * `ctx.features['knowledge-sync']` surface. See pack.json for the full contract.
 *
 * The whole ADR 0605-hardened orchestration (list → diff → fetch+ingest → prune,
 * pre-run lease, destructive-diff refusal, Tier-2 erasure) lives in the host
 * surface, not here — this node is the thin chain-expressible wrapper that makes
 * the recurring sync a real registered/owned/replayable workflow run on the ONE
 * host scheduler, replacing the retired bespoke daemon.
 */

/** Merge chain-authored config with DAG-forwarded inputs (inputs win on conflict). */
function args(ctx) {
  return { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
}
const str = (v) => (typeof v === 'string' ? v : '');

async function knowledgeSyncRun(ctx) {
  const ks = ctx.features && ctx.features['knowledge-sync'];
  if (!ks || typeof ks.runOnce !== 'function') {
    return {
      status: 'failure',
      error: {
        code: 'host_capability_missing',
        message: "host does not expose ctx.features['knowledge-sync'] — the knowledge-sync feature must be composed.",
      },
    };
  }
  const sourceId = str(args(ctx).sourceId);
  if (!sourceId) {
    return { status: 'failure', error: { code: 'validation_error', message: 'sourceId is required.' } };
  }
  try {
    const result = await ks.runOnce({ sourceId });
    // Run-status fidelity: a NON-throwing pass failure (the surface returns
    // {status:'failure'} after syncNow recorded the error on the source) is a FAILED
    // run, not a success carrying a failure. A skip / success is a successful run.
    if (result && result.status === 'failure') {
      return { status: 'failure', error: (result.error) || { code: 'sync_failed', message: 'knowledge sync failed' } };
    }
    return { status: 'success', outputs: result };
  } catch (err) {
    // The surface seam throws `host_capability_disabled` for a toggled-OFF tenant
    // BEFORE the run body executes, so nothing was spent — convert it to a clean
    // skip rather than a failed run (WF-KB-4: a disabled tenant does zero egress).
    if (err && err.code === 'host_capability_disabled') {
      return { status: 'success', outputs: { status: 'skipped', reason: 'feature-disabled' } };
    }
    return {
      status: 'failure',
      error: { code: (err && err.code) || 'internal_error', message: (err && err.message) || String(err) },
    };
  }
}

export const nodes = { 'feature.knowledge-sync.nodes.run': knowledgeSyncRun };

export default nodes;
