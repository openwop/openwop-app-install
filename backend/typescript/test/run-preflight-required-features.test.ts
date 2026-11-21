/**
 * The run admission preflight ADR (D3, P1) — required features, checked at run
 * admission (CC-ORCH-2).
 *
 * MEASURED in Campaign Studio acceptance (CasaVoga, v0.14.0): a campaign
 * orchestration in a workspace with Production off generated and gated every
 * channel, then failed `host_capability_disabled: feature production is not
 * enabled` at the production-plan step. `chainRequirements` knew the chain needed
 * Production, but only the template pre-flight read it, client-side; nothing
 * checked it when the run started.
 *
 * Pinned here: the required set unions the definition, its co-registered child
 * definitions, node declarations and the chain's `x-requiresFeatures`, minus
 * optional reads; shadow records a `feature_disabled` finding and admits;
 * enforce refuses 422 `run_preflight_failed` before the row is written; the
 * operator's re-checked ADR 1108 exemption passes a plan block; a replay is
 * never checked; a branch fork and a sub-workflow child are.
 *
 * Red witness: main's `src/host/runInsert.ts` (no D3 call) → the shadow,
 * enforce, branch-fork and child cases go red; the pure cases need
 * `src/host/runPreflight.ts` from this branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const off = new Map<string, 'toggle' | 'plan'>();

vi.mock('../src/host/workflowChainPackLoader.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getChain: (id: string) => (id === 'test.orch'
    ? { packName: 'test.chains', packVersion: '1.0.0', chain: { chainId: id, parameters: {}, 'x-requiresFeatures': ['commerce', { id: 'crm', optional: true }] } }
    : null),
}));
vi.mock('../src/host/featureToggles/registry.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getToggleDefault: (id: string) => (['production', 'campaign-brief', 'campaign-channels', 'documents', 'creative-briefs', 'commerce', 'crm'].includes(id)
    ? { id, label: id === 'production' ? 'Production' : id, status: 'on' }
    : null),
}));
vi.mock('../src/host/featureToggles/service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveOne: async (id: string, subject: { planExempt?: boolean }) => {
    const why = off.get(id);
    if (!why) return { id, status: 'on', enabled: true, variant: null };
    if (why === 'plan' && subject.planExempt) return { id, status: 'on', enabled: true, variant: null };
    return { id, status: why === 'plan' ? 'on' : 'off', enabled: false, variant: null, ...(why === 'plan' ? { blockedBy: 'plan' } : {}) };
  },
}));

const CHILD = {
  workflowId: 'wf.child.channels', name: 'Channels', edges: [],
  nodes: [
    { nodeId: 'c1', typeId: 'feature.campaign-channels.nodes.create-creative-briefs@1.0.0' }, // creative-briefs: optional
    { nodeId: 'c2', typeId: 'feature.campaign-channels.nodes.publish-social-posts@1.0.0' }, // documents: required
  ],
} as unknown as WorkflowDefinition;

vi.mock('../src/host/workflowsRegistry.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getRegisteredWorkflowAsync: async (id: string) => (id === 'wf.child.channels' ? CHILD : null),
}));

const { insertRunWithStartContext } = await import('../src/host/runInsert.js');
const { requiredFeatureIds, featureDisabledFindings, parseFeatureNeeds } = await import('../src/host/runPreflight.js');
const { nodeFeatureDecl } = await import('../src/host/nodeFeatureRequirements.js');

const now = '2026-11-16T00:00:00.000Z';
const DEF = {
  workflowId: 'wf.copy.orch', name: 'Campaign orchestration', edges: [],
  nodes: [
    { nodeId: 'validate', typeId: 'feature.campaign-brief.nodes.validate@1.0.0' },
    // context-build, not plan-generate: plan-generate skips when Production is off
    // (`ownOptional`, test/production-plan-skip-when-off.test.ts), so it no longer
    // makes Production required; context-build still does.
    { nodeId: 'plan', typeId: 'feature.production.nodes.context-build@1.0.0' },
    { nodeId: 'channels', typeId: 'core.subWorkflow', config: { workflowId: 'wf.child.channels' } },
    { nodeId: 'gone', typeId: 'core.subWorkflow', config: { workflowId: 'wf.child.unresolvable' } },
  ],
  metadata: { expandedFrom: { chainId: 'test.orch', version: '1.0.0', params: {} } },
} as unknown as WorkflowDefinition;
const run = (over: Partial<RunRecord> & { runId: string }): RunRecord => ({
  workflowId: 'wf.copy.orch', tenantId: 'ws:p1', status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now, ...over,
});
const ADMIT = { admission: { plan: 'exempt:test-fixture' as const }, definition: DEF };
type Stored = { preflightFindings?: Array<{ kind: string; feature?: string; blockedBy?: string }> };
const tags = (m: unknown): string[] => ((m as Stored).preflightFindings ?? []).map((f) => `${f.kind}:${f.feature}:${f.blockedBy}`);

let storage: Storage;
const savedSuper = process.env.OPENWOP_SUPERADMIN_TENANTS;
beforeEach(async () => {
  storage = await openStorage('memory://');
  delete process.env.OPENWOP_RUN_PREFLIGHT;
  process.env.OPENWOP_SUPERADMIN_TENANTS = 'user:p1-operator';
  off.clear();
});
afterEach(() => {
  delete process.env.OPENWOP_RUN_PREFLIGHT;
  if (savedSuper === undefined) delete process.env.OPENWOP_SUPERADMIN_TENANTS; else process.env.OPENWOP_SUPERADMIN_TENANTS = savedSuper;
});

describe('run admission preflight D3 — the required set (pure)', () => {
  it('unions own features, child definitions, node declarations and the chain, minus optional reads', () => {
    const ids = requiredFeatureIds([DEF, CHILD], nodeFeatureDecl, (id) => (id === 'test.orch' ? parseFeatureNeeds(['commerce', { id: 'crm', optional: true }]) : []));
    expect(ids).toEqual(['campaign-brief', 'campaign-channels', 'commerce', 'documents', 'production']);
    expect(ids).not.toContain('creative-briefs');
    expect(ids).not.toContain('crm');
  });

  it('a feature that is not toggle-gated drops out; an enabled one gives nothing', () => {
    const out = featureDisabledFindings(['kb', 'production', 'documents'], (id) => (id === 'kb' ? null : id === 'production' ? { label: 'Production', enabled: false } : { label: 'Documents', enabled: true }));
    expect(out.map((f) => `${f.feature}:${f.blockedBy}`)).toEqual(['production:toggle']);
    expect(out[0]!.message).toContain('Production');
  });
});

describe('run admission preflight D3 — at insertRunWithStartContext', () => {
  it('shadow (default): admits the run and records Production off; an optional read off records nothing', async () => {
    off.set('production', 'toggle');
    off.set('creative-briefs', 'toggle');
    await insertRunWithStartContext(storage, run({ runId: 'r-shadow' }), ADMIT);
    const stored = await storage.getRun('r-shadow');
    expect(stored).toBeTruthy();
    expect(tags(stored!.metadata)).toEqual(['feature_disabled:production:toggle']);
  });

  it('enforce: refuses 422 run_preflight_failed naming the feature, and writes no row', async () => {
    process.env.OPENWOP_RUN_PREFLIGHT = 'enforce';
    off.set('production', 'toggle');
    await expect(insertRunWithStartContext(storage, run({ runId: 'r-enforce' }), ADMIT)).rejects.toMatchObject({
      httpStatus: 422,
      details: { reason: 'run_preflight_failed', findings: [expect.objectContaining({ kind: 'feature_disabled', feature: 'production', label: 'Production' })] },
    });
    expect(await storage.getRun('r-enforce')).toBeNull();
  });

  it('a feature the child definition needs is checked too (documents)', async () => {
    off.set('documents', 'toggle');
    await insertRunWithStartContext(storage, run({ runId: 'r-child-def' }), ADMIT);
    expect(tags((await storage.getRun('r-child-def'))!.metadata)).toEqual(['feature_disabled:documents:toggle']);
  });

  it('a plan block is a finding for a customer, and the operator\'s re-checked exemption passes it', async () => {
    off.set('production', 'plan');
    await insertRunWithStartContext(storage, run({ runId: 'r-customer', metadata: { actingUserId: 'p1-customer', personalTenant: 'user:p1-customer' } }), ADMIT);
    expect(tags((await storage.getRun('r-customer'))!.metadata)).toEqual(['feature_disabled:production:plan']);
    await insertRunWithStartContext(storage, run({ runId: 'r-operator', metadata: { actingUserId: 'p1-operator', personalTenant: 'user:p1-operator', planExempt: true } }), ADMIT);
    expect((await storage.getRun('r-operator'))!.metadata).not.toHaveProperty('preflightFindings');
  });

  it('a replay is never checked, even under enforce', async () => {
    process.env.OPENWOP_RUN_PREFLIGHT = 'enforce';
    off.set('production', 'toggle');
    await insertRunWithStartContext(storage, run({ runId: 'r-replay', parentRunId: 'r-src', forkMode: 'replay' }), { ...ADMIT, derivedFromRun: true });
    expect((await storage.getRun('r-replay'))!.metadata).not.toHaveProperty('preflightFindings');
  });

  it('a branch fork re-executes nodes, so it is checked', async () => {
    process.env.OPENWOP_RUN_PREFLIGHT = 'enforce';
    off.set('production', 'toggle');
    await expect(insertRunWithStartContext(storage, run({ runId: 'r-branch', parentRunId: 'r-src', forkMode: 'branch' }), { ...ADMIT, derivedFromRun: true }))
      .rejects.toMatchObject({ httpStatus: 422, details: { reason: 'run_preflight_failed' } });
    expect(await storage.getRun('r-branch')).toBeNull();
  });

  it('a sub-workflow child run is checked for features (not for params)', async () => {
    off.set('production', 'toggle');
    await insertRunWithStartContext(storage, run({ runId: 'r-subrun', parentRunId: 'r-parent' }), ADMIT);
    expect(tags((await storage.getRun('r-subrun'))!.metadata)).toEqual(['feature_disabled:production:toggle']);
  });

  it('off records nothing', async () => {
    process.env.OPENWOP_RUN_PREFLIGHT = 'off';
    off.set('production', 'toggle');
    await insertRunWithStartContext(storage, run({ runId: 'r-off' }), ADMIT);
    expect((await storage.getRun('r-off'))!.metadata).not.toHaveProperty('preflightFindings');
  });
});
