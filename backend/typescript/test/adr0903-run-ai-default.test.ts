/**
 * ADR 0903 — no hard-coded AI vendor. A node that names no provider/model gets,
 * in order: the run's own choice (`configurable.ai`), else the workspace's active
 * AI binding, else the catalog default — the last two frozen at run creation.
 *
 * Measured 2026-10-17: a Campaign Studio run on a Gemini key failed
 * `byok_required` for an ANTHROPIC key, because `feature.campaign-brief.nodes`
 * filled the missing provider with `'anthropic'` and the chain never named one.
 *
 * Sabotage that turns these red: a pack regaining `|| 'anthropic'` or a pack-local
 * model constant (the ratchet); `withRunAiDefault` ignoring the default; the
 * contributor resolving on a fork; a managed binding being taken as the default;
 * the campaign chains losing the provider/model bindings or the per-child inputs;
 * a child run dropping the parent's `configurable.ai` choice.
 */
import { readdirSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const binding = vi.hoisted(() => ({ current: null as null | { tenantId: string; provider: string; model: string; credentialRef: string; updatedAt: string } }));
vi.mock('../src/host/chatByokConfig.js', async (orig) => ({
  ...(await orig<object>()),
  getChatByokConfig: async () => binding.current,
}));

const { runAiDefaultContributor, runAiDefaultFor, withRunAiDefault, RUN_AI_DEFAULT_KEY } = await import('../src/host/runAiDefault.js');
const { getDefaultModel, listSelectableProviderIds } = await import('../src/providers/catalog.js');
const { expandChain } = await import('../src/host/workflowChainPackLoader.js');
const { openStorage } = await import('../src/storage/index.js');
const { __resetHostExtPersistence, initHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
const { initInMemorySurfaces } = await import('../src/host/inMemorySurfaces.js');
const { dispatchSubWorkflow, setSubWorkflowDispatcher } = await import('../src/executor/subWorkflowDispatcher.js');
const { insertRunWithStartContext } = await import('../src/host/runInsert.js');

const REPO = join(import.meta.dirname, '..', '..', '..');
const now = '2026-10-17T00:00:00.000Z';

beforeEach(() => { binding.current = null; });

describe('withRunAiDefault — fills only what the node left out', () => {
  const def = { provider: 'google', model: 'gemini-x', source: 'workspace' as const };
  it('a call naming no provider takes the default provider AND model', () => {
    expect(withRunAiDefault({ provider: undefined, model: undefined }, def)).toMatchObject({ provider: 'google', model: 'gemini-x' });
  });
  it('a call naming a provider keeps it; a missing model is THAT provider\'s default', () => {
    expect(withRunAiDefault({ provider: 'openai', model: undefined }, def)).toMatchObject({ provider: 'openai', model: getDefaultModel('openai') });
    expect(withRunAiDefault({ provider: 'google', model: undefined }, def)).toMatchObject({ provider: 'google', model: 'gemini-x' });
  });
  it('a call naming both is untouched, and no default leaves the call as it was', () => {
    const req = { provider: 'anthropic', model: 'm' };
    expect(withRunAiDefault(req, def)).toBe(req);
    expect(withRunAiDefault({ provider: undefined }, null)).toEqual({ provider: undefined });
  });
});

describe('runAiDefaultFor — the run\'s choice first, then the frozen default', () => {
  it('configurable.ai.provider wins over the frozen value', () => {
    const d = runAiDefaultFor({ ai: { provider: 'google', model: 'gemini-y' } }, { [RUN_AI_DEFAULT_KEY]: { provider: 'anthropic', model: 'c', source: 'catalog' } });
    expect(d).toEqual({ provider: 'google', model: 'gemini-y', source: 'run' });
  });
  it('a run provider without a model gets that provider\'s catalog default', () => {
    expect(runAiDefaultFor({ ai: { provider: 'openai' } }, undefined)).toEqual({ provider: 'openai', model: getDefaultModel('openai'), source: 'run' });
  });
  it('an unknown run provider is ignored; the frozen value applies; junk metadata is null', () => {
    expect(runAiDefaultFor({ ai: { provider: 'nope' } }, { [RUN_AI_DEFAULT_KEY]: { provider: 'google', model: 'g', source: 'workspace' } })?.provider).toBe('google');
    expect(runAiDefaultFor({}, { [RUN_AI_DEFAULT_KEY]: 'anthropic' })).toBeNull();
    expect(runAiDefaultFor(undefined, undefined)).toBeNull();
  });
});

describe('run-start contributor — frozen once, never on a fork', () => {
  it('the workspace\'s BYOK binding is the default', async () => {
    binding.current = { tenantId: 't', provider: 'google', model: 'gemini-z', credentialRef: 'google:testing', updatedAt: now };
    expect(await runAiDefaultContributor({ tenantId: 't' })).toEqual({ [RUN_AI_DEFAULT_KEY]: { provider: 'google', model: 'gemini-z', source: 'workspace' } });
  });
  it('a managed (chat-only) binding is skipped for the catalog default', async () => {
    // A SELECTABLE provider on a managed ref — so only the managed check can refuse it.
    binding.current = { tenantId: 't', provider: 'google', model: 'm', credentialRef: 'managed:openwop-free', updatedAt: now };
    const first = listSelectableProviderIds()[0]!;
    expect(await runAiDefaultContributor({ tenantId: 't' })).toEqual({ [RUN_AI_DEFAULT_KEY]: { provider: first, model: getDefaultModel(first), source: 'catalog' } });
  });
  it('no binding ⇒ the catalog default; a fork contributes nothing', async () => {
    expect(((await runAiDefaultContributor({ tenantId: 't' }))[RUN_AI_DEFAULT_KEY] as { source: string }).source).toBe('catalog');
    binding.current = { tenantId: 't', provider: 'google', model: 'g', credentialRef: 'google:x', updatedAt: now };
    expect(await runAiDefaultContributor({ tenantId: 't', derivedFromRun: true })).toEqual({});
  });
});

describe('ratchet — no node pack hard-codes an AI vendor', () => {
  it('no packs/*/index.mjs falls back to a named provider or carries a pack-local default model', () => {
    const offenders: string[] = [];
    for (const dir of readdirSync(join(REPO, 'packs'))) {
      const f = join(REPO, 'packs', dir, 'index.mjs');
      if (!existsSync(f)) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, n) => {
        if (/\|\|\s*['"](anthropic|openai|google)['"]/.test(line) || /const\s+DEFAULT_MODEL\s*=/.test(line) || /\|\|\s*FACTORY_AI_DEFAULT\./.test(line)) {
          offenders.push(`${dir}/index.mjs:${n + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('Campaign Studio chains carry the user\'s provider/model to every AI node', () => {
  const chainsOf = (pack: string) => (JSON.parse(readFileSync(join(REPO, 'examples/workflow-chain-packs', pack, 'pack.json'), 'utf8')) as { chains: Array<{ chainId: string }> }).chains;
  const AI = /^feature\.(campaign-brief\.nodes\.(generate-kernel|extract-voc|generate-angles|build-targeting)|campaign-channels\.nodes\.generate|production\.nodes\.plan-generate|campaign-orchestration\.nodes\.consistency-check)$/;
  const nodesOf = (def: { nodes: Array<{ typeId: string; inputs?: Record<string, unknown>; config?: Record<string, unknown> }> }) => def.nodes;

  it('instantiated with provider/model, every AI node has them; without, the keys are absent (the host fills them)', () => {
    let aiNodes = 0;
    for (const pack of ['campaign-brief', 'campaign-channels', 'campaign-orchestration']) {
      for (const chain of chainsOf(pack)) {
        const withAi = expandChain(chain as never, { params: { briefId: 'b1', platform: 'meta', provider: 'google', model: 'gemini-3.8-flash' } }) as never;
        const without = expandChain(chain as never, { params: { briefId: 'b1', platform: 'meta' } }) as never;
        for (const n of nodesOf(withAi)) if (AI.test(n.typeId.split('@')[0]!)) {
          aiNodes += 1;
          expect(n.inputs, `${chain.chainId} ${n.typeId}`).toMatchObject({ provider: 'google', model: 'gemini-3.8-flash' });
        }
        for (const n of nodesOf(without)) if (AI.test(n.typeId.split('@')[0]!)) {
          expect(n.inputs?.provider, `${chain.chainId} ${n.typeId}`).toBeUndefined();
        }
      }
    }
    expect(aiNodes, 'messaging-kernel 1 + market-intel 3 + 5 channels + orchestration 3').toBe(12);
  });

  it('orchestration hands the brief and the same provider/model to each of its five channel children', () => {
    // Measured live 2026-10-18: the dispatch's `inputMapping` reads the parent's
    // VARIABLE bag, but from-chain freezes briefId into node inputs, so every
    // child failed `brief_not_found` until briefId rode the per-child inputs too.
    const [chain] = chainsOf('campaign-orchestration');
    const def = expandChain(chain as never, { params: { briefId: 'b1', provider: 'google', model: 'gemini-3.8-flash' } }) as never;
    const sup = nodesOf(def).find((n) => n.typeId.startsWith('core.orchestrator.supervisor'))!;
    const step = (sup.config!.mockDispatchPlan as Array<{ kind: string; nextWorkerIds?: string[]; nextWorkerInputs?: unknown[] }>).find((s) => s.kind === 'next-worker')!;
    expect(step.nextWorkerInputs).toHaveLength(step.nextWorkerIds!.length);
    for (const x of step.nextWorkerInputs!) expect(x).toEqual({ briefId: 'b1', provider: 'google', model: 'gemini-3.8-flash' });
  });

  it('the consistency check receives the dispatch outcomes and fails when every channel failed', async () => {
    const [chain] = chainsOf('campaign-orchestration');
    const def = expandChain(chain as never, { params: { briefId: 'b1' } }) as never as { nodes: Array<{ nodeId: string; typeId: string }>; edges: Array<{ sourceNodeId: string; targetNodeId: string; sourceOutput?: string; targetInput?: string }> };
    const idOf = (t: string) => def.nodes.find((n) => n.typeId.startsWith(t))!.nodeId;
    expect(def.edges).toContainEqual(expect.objectContaining({
      sourceNodeId: idOf('core.dispatch'), sourceOutput: 'dispatched',
      targetNodeId: idOf('feature.campaign-orchestration.nodes.consistency-check'), targetInput: 'dispatched',
    }));

    const { consistencyCheck } = await import(join(REPO, 'packs/feature.campaign-orchestration.nodes/index.mjs')) as { consistencyCheck: (ctx: unknown) => Promise<{ status: string; error?: { code: string } }> };
    const ctx = (dispatched: unknown) => ({ inputs: { briefId: 'b1', dispatched }, features: {} });
    const allFailed = [{ childWorkflowId: 'campaign-studio.channel.landing-page', childStatus: 'failed' }, { childWorkflowId: 'campaign-studio.channel.ad-variants', childStatus: 'cancelled' }];
    expect(await consistencyCheck(ctx(allFailed))).toMatchObject({ status: 'failed', error: { code: 'channels_all_failed' } });
    expect((await consistencyCheck(ctx([...allFailed, { childWorkflowId: 'x', childStatus: 'completed' }]))).status).toBe('success');
    expect((await consistencyCheck(ctx(undefined))).status).toBe('success');
  });
});

describe('a child run inherits the parent run\'s provider/model choice', () => {
  let storage: Awaited<ReturnType<typeof openStorage>>;
  const catalog = { getWorkflow: async (id: string) => ({ workflowId: id, definition: { workflowId: id, nodes: [], edges: [], variables: [] } }) };
  const policy = { resolveForRun: async () => [] };
  const executed: Array<{ runId: string; options: unknown }> = [];
  beforeAll(async () => {
    storage = await openStorage('memory://');
    initHostExtPersistence(storage);
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0903-')) });
    setSubWorkflowDispatcher({ storage, hostSuite: { workflowCatalog: catalog, providerPolicyResolver: policy } as never, executeRun: async (_s: unknown, run: { runId: string }, _d: unknown, options: unknown) => { executed.push({ runId: run.runId, options }); return {}; } });
    await insertRunWithStartContext(storage, { runId: 'p-ai', workflowId: 'wf.parent', tenantId: 'adr0903', status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now } as never);
  });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });

  it('parentAi lands on the child\'s configurable.ai; without it the child has none', async () => {
    const withAi = await dispatchSubWorkflow({ parentRunId: 'p-ai', parentTenantId: 'adr0903', childWorkflowId: 'wf.child', parentNodeId: 'n', waitForCompletion: false, parentAi: { provider: 'google', model: 'gemini-3.8-flash' } });
    expect((await storage.getRun(withAi.childRunId!))?.configurable).toMatchObject({ ai: { provider: 'google', model: 'gemini-3.8-flash' } });
    const without = await dispatchSubWorkflow({ parentRunId: 'p-ai', parentTenantId: 'adr0903', childWorkflowId: 'wf.child', parentNodeId: 'n', waitForCompletion: false });
    expect((await storage.getRun(without.childRunId!))?.configurable?.ai).toBeUndefined();
  });

  it('a child run is executed with the host\'s provider policy, so its nodes get ctx.callAI', async () => {
    // Measured live 2026-10-18: children ran with `{}` options, so the executor
    // built no AI adapter and every channel child failed `capability_missing`.
    const r = await dispatchSubWorkflow({ parentRunId: 'p-ai', parentTenantId: 'adr0903', childWorkflowId: 'wf.child', parentNodeId: 'n', waitForCompletion: true });
    const call = executed.find((e) => e.runId === r.childRunId);
    expect(call, 'executeRun was called for the child').toBeDefined();
    expect((call!.options as { policyResolver?: unknown }).policyResolver).toBe(policy);
  });
});
