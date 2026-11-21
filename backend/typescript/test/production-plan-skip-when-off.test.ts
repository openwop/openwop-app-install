/**
 * ADR 0356 P1 × the run admission preflight ADR (D3) — the campaign spine's
 * production step SKIPS when Production is off, and the preflight does not
 * require Production for it.
 *
 * MEASURED (CasaVoga, v0.14.0; production log 2026-11-17 12:50Z): a campaign
 * orchestration in a workspace with Production off failed at the production-plan
 * step, then the run-preflight flagged `feature_disabled:production` for every
 * such run. The node's "SKIP honestly" guard tested
 * `typeof ctx.features.production.buildContext !== 'function'`, which never fires
 * on this host. `host/featureSurfaces.ts` `gate` always hands the node a wrapped
 * function and throws `host_capability_disabled` per call when the feature is off.
 *
 * Pinned here:
 *  - the node returns `skipped: true` on that error, and still rethrows any other;
 *  - the preflight's required set drops `production` for plan-generate only
 *    (`ownOptional`), keeps it for context-build, and a pack-wide entry can never
 *    claim `ownOptional`.
 *
 * Red witness: main's packs/feature.production.nodes/index.mjs fails the skip
 * case (the error escapes); main's nodeFeatureRequirements.ts/runPreflight.ts fail
 * the preflight case (`production` stays required).
 */
import { describe, expect, it } from 'vitest';
import { planGenerate } from '../../../packs/feature.production.nodes/index.mjs';
import { requiredFeatureIds } from '../src/host/runPreflight.js';
import { NODE_FEATURE_REQUIREMENTS, nodeFeatureDecl } from '../src/host/nodeFeatureRequirements.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

/** The shape `featureSurfaces.ts` `gate` throws for an OFF feature. */
const disabled = () => Object.assign(
  new Error("feature 'production' is not enabled for this tenant — ctx.features.production is unavailable"),
  { code: 'host_capability_disabled', capability: 'host.sample.production' },
);

function ctxWith(buildContext: () => Promise<unknown>) {
  return {
    inputs: { orgId: 'org-a', channels: ['landing_page'] },
    features: { production: { buildContext, savePlan: async () => { throw new Error('must not save'); } } },
    callAI: async () => { throw new Error('must not call the model'); },
  };
}

describe('plan-generate with Production off', () => {
  it('skips with a reason instead of failing the step', async () => {
    const out = await planGenerate(ctxWith(async () => { throw disabled(); }));
    expect(out).toEqual({ status: 'success', outputs: { skipped: true, reason: 'production feature is not enabled for this tenant' } });
  });

  it('still fails on any other error', async () => {
    await expect(planGenerate(ctxWith(async () => { throw Object.assign(new Error('boom'), { code: 'internal' }); })))
      .rejects.toThrow('boom');
  });
});

describe('the preflight does not require Production for plan-generate', () => {
  const def = (typeId: string) => ({
    workflowId: 'wf.t', name: 't', edges: [], nodes: [{ nodeId: 'n', typeId }],
  }) as unknown as WorkflowDefinition;
  const noChain = () => [];

  it('drops production for plan-generate and keeps it for context-build', () => {
    expect(requiredFeatureIds([def('feature.production.nodes.plan-generate@1.0.0')], nodeFeatureDecl, noChain)).not.toContain('production');
    expect(requiredFeatureIds([def('feature.production.nodes.context-build@1.0.0')], nodeFeatureDecl, noChain)).toContain('production');
  });

  it('honours ownOptional only on an exact node entry, never a pack-wide one', () => {
    const wide = Object.entries(NODE_FEATURE_REQUIREMENTS).filter(([k, e]) => k.endsWith('.*') && e.ownOptional === true).map(([k]) => k);
    expect(wide).toEqual([]);
  });
});
