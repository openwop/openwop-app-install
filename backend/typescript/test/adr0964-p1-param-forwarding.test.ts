/**
 * ADR 0964 D2 — a chain parent forwards its params to a sub-chain.
 *
 * `core.subWorkflow` / `core.dispatch` `inputMapping` reads the PARENT's variable bag by
 * name (`subWorkflowDispatcher.ts`). Path A froze params into config with no variables,
 * and deferred mode materializes them under PREFIXED names, so in both a mapped param
 * reached the child as `undefined` (campaign orchestration was measured failing
 * `brief_not_found` live, 2026-10-18). Now:
 *  - expansion records the mapped params in `metadata.forwardedParams` (Path A: frozen
 *    values) or `metadata.forwardedParamAliases` (deferred: bare → materialized name);
 *  - the executor writes them into the bag at run start under the bare name.
 * They are NOT declared variables: a variable is a per-run input the run form prompts
 * for and a caller can override, which would split the parent's frozen value from the
 * child's (the /code-review finding on the first cut of D2).
 *
 * BORN RED: before D2, the child run receives `undefined` (leg 1's `seen` stays unset).
 *
 * Sabotage witnesses (w73 probes, each reds the named case): forwardedParams not
 * recorded (w73g3-pf64-frozen), core.dispatch / perWorkerInputMappings skipped
 * (pf64-dispatch, pf64-perworker), the sensitive refusal dropped (pf64-sensitive),
 * the deferred alias dropped (pf64-alias), a bag value overwritten (pf64-nooverwrite),
 * the executor's applyForwardedParams call removed (pf64-executor).
 *
 * DOUBLE GUARD (recorded, TST-DRV): "a mapping naming a produced value forwards
 * nothing" is held both by the `paramProps` own-property check and by the
 * `resolvedParams[name] !== undefined` check in workflowChainPackLoader.ts. A
 * produced name is neither a param nor resolved, so removing either one alone is
 * an equivalent mutant; w73g3-pf64-produced removes both in one edit.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expandChain, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';
import { applyForwardedParams, seedRunVariables, snapshotRunVariables, setRunVariable } from '../src/host/variablesRuntime.js';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { bareRunId } from './support/bareRunId.js';

const chain = (over: Partial<WorkflowChain>): WorkflowChain => ({
  chainId: 'c.parent', version: '1.0.0', label: 'Parent', description: 'p',
  parameters: { type: 'object', properties: {} },
  dag: { nodes: [{ id: 'n1', typeId: 'core.fail', config: {} }], edges: [] },
  ...over,
});
const parent = (props: Record<string, unknown>, nodes: WorkflowChain['dag']['nodes']): WorkflowChain => chain({
  parameters: { type: 'object', properties: props },
  dag: { nodes, edges: [] },
});
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Read the two forwarding maps off an expanded definition's metadata, without a cast. */
const meta = (def: { metadata?: unknown }): { forwardedParams?: Record<string, unknown>; forwardedParamAliases?: Record<string, string> } => {
  const md = def.metadata;
  if (!isRecord(md)) return {};
  const out: { forwardedParams?: Record<string, unknown>; forwardedParamAliases?: Record<string, string> } = {};
  if (isRecord(md.forwardedParams)) out.forwardedParams = md.forwardedParams;
  if (isRecord(md.forwardedParamAliases)) {
    const aliases: Record<string, string> = {};
    for (const [k, v] of Object.entries(md.forwardedParamAliases)) if (typeof v === 'string') aliases[k] = v;
    out.forwardedParamAliases = aliases;
  }
  return out;
};
/** A run's status from a GET /runs/:id body (`undefined` when absent). */
const statusOf = (body: unknown): unknown => (isRecord(body) ? body.status : undefined);

describe('ADR 0964 D2 — expansion records the params a sub-chain maps', () => {
  it('Path A: frozen values in metadata.forwardedParams, NO declared variables (nothing for a run form to prompt)', () => {
    const c = parent(
      { orgId: { type: 'string' }, briefId: { type: 'string' }, unused: { type: 'string' } },
      [{ id: 'step', typeId: 'core.subWorkflow', config: { inputMapping: { orgId: 'orgId', brief: 'briefId' } } }],
    );
    const def = expandChain(c, { params: { orgId: 'org-a', briefId: 'b-1', unused: 'x' } });
    expect(meta(def).forwardedParams).toEqual({ briefId: 'b-1', orgId: 'org-a' });
    expect(def.variables ?? []).toEqual([]);
  });

  it('core.dispatch inputMapping and perWorkerInputMappings are covered too', () => {
    const c = parent(
      { briefId: { type: 'string' }, provider: { type: 'string' } },
      [{ id: 'fan', typeId: 'core.dispatch', config: { inputMapping: { briefId: 'briefId' }, perWorkerInputMappings: { 'wf.a': { provider: 'provider' } } } }],
    );
    expect(meta(expandChain(c, { params: { briefId: 'b-2', provider: 'google' } })).forwardedParams).toEqual({ briefId: 'b-2', provider: 'google' });
  });

  it('Path A: a sensitive mapped param fails expansion closed (no secret at rest in the bag)', () => {
    const c = parent({ apiKey: { type: 'string', 'x-openwop-sensitive': true } }, [{ id: 'step', typeId: 'core.subWorkflow', config: { inputMapping: { key: 'apiKey' } } }]);
    expect(() => expandChain(c, { params: { apiKey: 'sk-secret' } })).toThrow(/sensitive_param_not_deferrable/);
  });

  it('deferred mode: the mapped param is aliased to its materialized variable, and the bag gets it under the bare name', () => {
    const c = parent({ orgId: { type: 'string' } }, [{ id: 'step', typeId: 'core.subWorkflow', config: { inputMapping: { orgId: 'orgId' } } }]);
    const def = expandChain(c, { params: { orgId: 'org-d' }, deferred: true });
    const alias = meta(def).forwardedParamAliases?.orgId;
    if (typeof alias !== 'string' || alias === '') throw new Error(`no alias recorded: ${JSON.stringify(def.metadata)}`);
    expect(alias).not.toBe('orgId');
    seedRunVariables('run-0964-deferred', def.variables, {});
    applyForwardedParams('run-0964-deferred', def.metadata);
    expect(snapshotRunVariables('run-0964-deferred')).toMatchObject({ orgId: 'org-d', [alias]: 'org-d' });
  });

  it('a mapping naming a produced value forwards nothing; a value already in the bag is never overwritten', () => {
    const c = chain({
      dag: { nodes: [{ id: 'gen', typeId: 'core.fail', config: {} }, { id: 'step', typeId: 'core.subWorkflow', config: { inputMapping: { days: 'batch0' } } }], edges: [] },
      producedVariables: [{ name: 'batch0', producedBy: 'gen', type: 'array' }],
    });
    expect(meta(expandChain(c)).forwardedParams).toBeUndefined();

    seedRunVariables('run-0964-keep', [{ name: 'orgId' }], { orgId: 'from-the-run' });
    applyForwardedParams('run-0964-keep', { forwardedParams: { orgId: 'frozen' } });
    expect(snapshotRunVariables('run-0964-keep')?.orgId).toBe('from-the-run');
    setRunVariable('run-0964-keep', 'other', undefined);
    applyForwardedParams('run-0964-keep', { forwardedParams: { other: 'frozen' } });
    expect(snapshotRunVariables('run-0964-keep')?.other).toBe('frozen');
  });
});

describe('ADR 0964 D2 — a real run: the child receives the frozen param', () => {
  let BASE = '';
  let close: () => Promise<void>;
  beforeAll(async () => { const h = await bootPlanningApp(); BASE = h.base; close = h.close; await enableToggle('users', 'on'); }, 120_000);
  afterAll(async () => {
    // Restore the toggle's shipped default (the boot turned it on for this file).
    const d = getToggleDefault('users');
    if (d) await saveConfig(d, 'test');
    await close();
  });

  it('the parent\'s frozen orgId reaches the child run\'s bag (and comes back through outputMapping)', async () => {
    const c: Client = makeClient(() => BASE);
    expect((await c.post('/host/openwop-app/test/login', { email: uniqEmail('d2'), tenantId: `org:d2-${Date.now()}` })).status).toBe(201);
    const childId = `test.d2.child.${Date.now()}`;
    // The child declares the input it is handed (RFC 0133 §1.3 does this for a co-registered sub-chain).
    registerWorkflow({ workflowId: childId, variables: [{ name: 'orgId' }], nodes: [{ nodeId: 'n', typeId: 'core.noop', config: {} }], edges: [] });
    const def = expandChain(parent({ orgId: { type: 'string' } }, [
      { id: 'step', typeId: 'core.subWorkflow', config: { workflowId: childId, inputMapping: { orgId: 'orgId' }, outputMapping: { seen: 'orgId' } } },
    ]), { params: { orgId: 'org-frozen' } });
    const parentId = `test.d2.parent.${Date.now()}`;
    registerWorkflow({ ...def, workflowId: parentId });

    const started = await c.post('/runs', { workflowId: parentId, inputs: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const runId: unknown = isRecord(started.body) ? started.body.runId : undefined;
    if (typeof runId !== 'string') throw new Error(`no runId: ${JSON.stringify(started.body)}`);
    // A run has no settle hook to await: poll its status until terminal (vi.waitFor throws on timeout).
    await vi.waitFor(async () => { expect(['completed', 'failed']).toContain(statusOf((await c.get(`/runs/${runId}`)).body)); }, { timeout: 30_000, interval: 25 });
    expect(statusOf((await c.get(`/runs/${runId}`)).body)).toBe('completed');
    expect(snapshotRunVariables(bareRunId(runId))?.seen, 'the child received undefined').toBe('org-frozen');
  });
});
