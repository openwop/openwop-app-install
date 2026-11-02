/**
 * The workflow AI adapter routes a MANAGED tools round through the managed tier.
 *
 * Measured on kicktodo.com 2026-09-16 21:00Z: a KickBot reminder coach turn
 * (agent-runner node, tools offered, credentialRef `managed:openwop-free`) failed
 * `provider_not_supported: Provider "openwop-free" is not in the host's
 * aiProviders.supported list.` `callAI` had a managed short-circuit;
 * `callAIWithTools` asserted the provider first and never reached the managed tier.
 * The chat conversation loop was unaffected because it calls
 * `dispatchManagedToolsRound` itself.
 *
 * ADR 0693 — the round also carries the ACTING participant (`actingSubject`), so
 * a shared workspace is metered per person. Red with the `isManagedCredentialRef`
 * short-circuit removed from `callAIWithTools` (aiProvidersHost.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type ManagedToolsRound = typeof import('../src/providers/managedProvider.js')['dispatchManagedToolsRound'];
const managedRound = vi.fn<ManagedToolsRound>(async () => ({
  text: 'Here is your nudge.',
  toolUses: [{ id: 'tu-1', name: 'openwop:kicktodo.today', input: { day: 1 } }],
  inputTokens: 12,
  outputTokens: 5,
}));

vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return { ...original, dispatchManagedToolsRound: managedRound };
});

let adapter: ReturnType<typeof import('../src/aiProviders/aiProvidersHost.js')['createAiProvidersAdapter']>;
let app: Awaited<ReturnType<typeof import('../src/index.js')['createApp']>>;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const { createApp } = await import('../src/index.js');
  const { createAiProvidersAdapter } = await import('../src/aiProviders/aiProvidersHost.js');
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0', enableConsoleTracer: false });
  const hostSuite = app.locals.hostSuite as import('../src/host/index.js').HostAdapterSuite;
  adapter = createAiProvidersAdapter({
    runId: 'run-managed-tools', nodeId: 'run', tenantId: 'host-shared', attempt: 1,
    actingUserId: 'user:participant-a',
    secrets: {}, policyResolver: hostSuite.providerPolicyResolver,
  });
  // A full createApp() behind a vi.mock'd module graph: ~15 s alone, and it ran
  // past the 30 s default hookTimeout under OPENWOP_CI_CLOCKSHIFT=1 in a 100-file
  // run (grade-tests w72 final verify, twice). Same budget as the repo's other boots.
}, 120_000);

afterAll(async () => {
  await (app.locals.storage as { close: () => Promise<void> }).close();
});

describe('callAIWithTools on a managed credential (workflow runs)', () => {
  const tool = { name: 'openwop:kicktodo.today', description: "Read the participant's Today", inputSchema: { type: 'object', properties: {} } };

  it('dispatches through the managed tier instead of refusing the managed tile id', async () => {
    const out = await adapter.callAIWithTools({
      provider: 'openwop-free',
      model: 'openwop-free',
      credentialRef: 'managed:openwop-free',
      systemPrompt: 'You are KickBot.',
      messages: [{ role: 'user', content: 'Nudge me.' }],
      tools: [tool],
    });
    expect(out.content).toBe('Here is your nudge.');
    expect(out.toolCalls).toEqual([{ id: 'tu-1', name: 'openwop:kicktodo.today', input: { day: 1 } }]);
    expect(managedRound).toHaveBeenCalledTimes(1);
    const req = managedRound.mock.calls[0]![0];
    expect(req.userFacingProvider).toBe('openwop-free');
    expect(req.tenantId).toBe('host-shared');
    // ADR 0693: the acting participant is metered, not the whole shared workspace.
    expect(req.actingSubject).toBe('user:participant-a');
    expect(req.tools.map((t) => t.name)).toEqual(['openwop:kicktodo.today']);
  });

  // ADR 1011 — the tool loop reads both; this adapter used to return neither.
  it('passes the stop reason and the invalid-arguments mark to the tool loop', async () => {
    managedRound.mockResolvedValueOnce({
      text: '',
      toolUses: [{ id: 'tu-2', name: tool.name, input: {}, argumentsInvalid: true }],
      finishReason: 'length',
    });
    const out = await adapter.callAIWithTools({
      provider: 'openwop-free', model: 'openwop-free', credentialRef: 'managed:openwop-free',
      messages: [{ role: 'user', content: 'Nudge me.' }], tools: [tool],
    });
    expect(out.finishReason).toBe('length');
    expect(out.toolCalls).toEqual([{ id: 'tu-2', name: tool.name, input: {}, argumentsInvalid: true }]);
  });

  it('a non-managed unknown provider is still refused (the guard is intact)', async () => {
    await expect(adapter.callAIWithTools({
      provider: 'openwop-free',
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
    })).rejects.toMatchObject({ code: 'provider_not_supported' });
  });
});
