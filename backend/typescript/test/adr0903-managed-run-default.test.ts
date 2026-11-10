/**
 * ADR 0903 correction (2026-11-02) — a workspace with no AI key runs its workflow
 * AI steps on the free managed tier.
 *
 * Measured on myndhyve.ai prod: the "Request Sign-off" template (badged "Zero
 * connections") failed in 125 ms with `byok_required: This step needs a anthropic
 * API key and this workspace has none`. The run default skipped managed bindings
 * and fell to the catalog's first provider, so a keyless workspace was frozen onto
 * Anthropic, although chat and agent steps already ran on the free tier.
 *
 * Pins:
 *   1. keyless signed-in workspace ⇒ frozen `source: 'managed'` with the sentinel;
 *   2. a key for some selectable provider ⇒ that provider, never managed;
 *   3. an anonymous sandbox, an unreadable vault, or a host whose managed tier
 *      has no key ⇒ the old catalog answer (so users still hear "add a key");
 *   4. the managed value round-trips through run metadata, and a forged
 *      non-managed ref on a `managed` source is refused;
 *   5. `withRunAiDefault` fills provider, model AND the sentinel, and leaves a
 *      call that carries its own key alone;
 *   6. end to end through the adapter: a call naming no provider reaches the
 *      managed dispatcher and never the network.
 *
 * Sabotage-witnessed (re-probed grade-tests w84 TST-FND-1): dropping the managed rung reds 1 and 6; skipping the held-
 * key check reds 2; dropping the anon, vault or readiness guard reds 3; accepting any ref in
 * `frozenOn` reds 4; not filling `credentialRef` reds 5 and 6.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const binding = vi.hoisted(() => ({ current: null as null | { tenantId: string; provider: string; model: string; credentialRef: string; updatedAt: string } }));
vi.mock('../src/host/chatByokConfig.js', async (orig) => ({
  ...(await orig<object>()),
  getChatByokConfig: async () => binding.current,
}));
const vault = vi.hoisted(() => ({ refs: [] as string[] | null }));
vi.mock('../src/byok/secretResolver.js', async (orig) => ({
  ...(await orig<object>()),
  listSecretRefs: async () => { if (vault.refs === null) throw new Error('vault down'); return vault.refs; },
}));
const managedChat = vi.hoisted(() => vi.fn(async (_req: unknown) => ({
  provider: 'openwop-free', model: 'openwop-free', completion: 'free-tier reply', usage: { inputTokens: 5, outputTokens: 3 }, finishReason: 'stop',
})));
const tier = vi.hoisted(() => ({ ready: true }));
vi.mock('../src/providers/managedProvider.js', async (orig) => ({
  ...(await orig<typeof import('../src/providers/managedProvider.js')>()),
  dispatchManagedChat: managedChat,
  getManagedProviderStatuses: async () => [{ providerId: 'openwop-free', ready: tier.ready, detail: '' }],
}));

const { resolveFrozenAiDefault, runAiDefaultFor, withRunAiDefault, RUN_AI_DEFAULT_KEY } = await import('../src/host/runAiDefault.js');
const { getDefaultModel, listManagedProviderIds, listSelectableProviderIds } = await import('../src/providers/catalog.js');

const MANAGED = listManagedProviderIds()[0]!;
const SELECTABLE = listSelectableProviderIds();
const USER = 'user:adr0903-managed';

beforeEach(() => { binding.current = null; vault.refs = []; tier.ready = true; managedChat.mockClear(); });

describe('the frozen run default for a workspace with no AI key', () => {
  it('fixture guard: the catalog lists a managed tier and at least two selectable providers', () => {
    expect(MANAGED).toBeTruthy();
    expect(SELECTABLE.length).toBeGreaterThan(1);
  });

  it('a keyless signed-in workspace runs on the managed tier', async () => {
    expect(await resolveFrozenAiDefault(USER)).toEqual({ provider: MANAGED, model: getDefaultModel(MANAGED), source: 'managed', credentialRef: `managed:${MANAGED}` });
    // A vault that holds only non-AI secrets is still keyless for AI.
    vault.refs = ['postmark-token', 'webhook:signing'];
    expect((await resolveFrozenAiDefault(USER))?.source).toBe('managed');
  });

  it('a key for any selectable provider wins over managed, even when it is not the catalog\'s first', async () => {
    const second = SELECTABLE[1]!;
    vault.refs = [`${second}:work`];
    expect(await resolveFrozenAiDefault(USER)).toEqual({ provider: second, model: getDefaultModel(second), source: 'catalog' });
    vault.refs = [`byok:${SELECTABLE[0]}`, `${second}`];
    expect((await resolveFrozenAiDefault(USER))?.provider).toBe(SELECTABLE[0]);
  });

  it('an anonymous sandbox, an unreadable vault and a host with no managed key keep the catalog answer', async () => {
    const catalog = { provider: SELECTABLE[0], model: getDefaultModel(SELECTABLE[0]!), source: 'catalog' };
    expect(await resolveFrozenAiDefault('anon:sess-1')).toEqual(catalog);
    vault.refs = null;
    expect(await resolveFrozenAiDefault(USER)).toEqual(catalog);
    vault.refs = [];
    tier.ready = false;
    expect(await resolveFrozenAiDefault(USER)).toEqual(catalog);
  });
});

describe('the managed default on a run', () => {
  it('round-trips through run metadata; a forged stored-key ref on a managed source is refused', () => {
    const def = { provider: MANAGED, model: 'm', source: 'managed', credentialRef: `managed:${MANAGED}` };
    expect(runAiDefaultFor({}, { [RUN_AI_DEFAULT_KEY]: def })).toEqual(def);
    expect(runAiDefaultFor({}, { [RUN_AI_DEFAULT_KEY]: { ...def, credentialRef: 'anthropic' } })).toBeNull();
    expect(runAiDefaultFor({}, { [RUN_AI_DEFAULT_KEY]: { ...def, credentialRef: undefined } })).toBeNull();
  });

  it('fills provider, model and the sentinel; a call with its own key or provider is left alone', () => {
    const def = { provider: MANAGED, model: 'mm', source: 'managed' as const, credentialRef: `managed:${MANAGED}` };
    expect(withRunAiDefault({ provider: undefined, model: 'claude-x' }, def)).toMatchObject({ provider: MANAGED, model: 'mm', credentialRef: `managed:${MANAGED}` });
    const ownKey = { provider: undefined, credentialRef: 'anthropic:work' };
    expect(withRunAiDefault(ownKey, def)).toBe(ownKey);
    expect(withRunAiDefault({ provider: 'openai', model: undefined }, def)).toEqual({ provider: 'openai', model: getDefaultModel('openai') });
  });
});

describe('end to end through the AI adapter', () => {
  let app: Awaited<ReturnType<typeof import('../src/index.js')['createApp']>>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const prevDsn = process.env.OPENWOP_STORAGE_DSN;
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    const { createApp } = await import('../src/index.js');
    app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0', enableConsoleTracer: false });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no live network call is allowed'));
  });
  afterAll(async () => {
    fetchSpy.mockRestore();
    await (app.locals.storage as { close: () => Promise<void> }).close();
    if (prevDsn === undefined) delete process.env.OPENWOP_STORAGE_DSN; else process.env.OPENWOP_STORAGE_DSN = prevDsn;
  });

  it('a step that names no provider, on a keyless workspace, is answered by the managed tier', async () => {
    const { createAiProvidersAdapter } = await import('../src/aiProviders/aiProvidersHost.js');
    const { beginNodeActivity } = await import('../src/host/effectIdentity.js');
    const policyResolver = (app.locals.hostSuite as import('../src/host/index.js').HostAdapterSuite).providerPolicyResolver;
    const runAiDefault = await resolveFrozenAiDefault(USER);
    const adapter = createAiProvidersAdapter({ runId: 'run-managed-default', nodeId: 'summarize', tenantId: USER, attempt: 1, secrets: {}, policyResolver, runAiDefault });
    beginNodeActivity('run-managed-default', 'summarize', 1);
    // Exactly what `core.ai.chatCompletion` sends when its chain left provider/model
    // unset (packs/core.openwop.ai/index.mjs passes `ctx.config.provider` through).
    // `AiCallRequest` types both as `string`, so the untyped JS call can only be
    // written with this cast (grade-tests w84 TST-FND-1: the one recorded cast).
    const out = await adapter.callAI({ provider: undefined as unknown as string, model: undefined as unknown as string, messages: [{ role: 'user', content: 'Summarize this for sign-off.' }] });
    expect(out.content).toBe('free-tier reply');
    expect(managedChat).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
