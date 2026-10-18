/**
 * CS-GB-1/2 (conversation-stack audit 2026-07-09) — the ONE conversation
 * model-target resolver + the same-provider reasoning bump for group rooms.
 *
 * The incident: board advisors seeded `modelClass:'reasoning'` answered on the
 * user's cheap default tier because the inline path had no tier notion — and
 * the tool loop read RAW run inputs, ignoring even a tenant-authored group
 * router rule AND the in-chat model override. Pins:
 *  - precedence: exchange override > stamped route > class-tier bump > inputs
 *  - the bump is SAME-provider only (providers.json classDefaults), group +
 *    reasoning only, and never fires when a stamp/override chose the model
 *  - tool-loop eligibility judges the RESOLVED provider (stamp/override aware)
 *  - a real board-group exchange stamps the BUMPED model end-to-end: the
 *    server-derived tier (ConversationMeta.type + the agent's modelClass) reaches
 *    the resolver on the exchange path, not just in a unit call
 *
 * Breaks if a group room's reasoning-class agent answers on the run's cheap
 * model again, if the bump crosses providers or overrides a stamp/override, or
 * if the tool loop judges eligibility on the raw run inputs.
 *
 * The end-to-end case needs a dispatchable provider WITH a reasoning class
 * default. The only keyless one is `mock`, which has none in providers.json, so
 * this file stubs `getClassDefault` for `mock` ONLY (catalog data, not the
 * mechanism — every other provider reads the real catalog). Without the stub the
 * bump is a no-op on `mock` and the case could not tell a bump from no bump —
 * which is exactly how the previous version of it passed vacuously.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { resolveConversationModelTarget } from '../src/features/model-router/applyRoute.js';
import { getClassDefault } from '../src/providers/catalog.js';
import { conversationToolTurnEligible } from '../src/host/conversationToolLoop.js';
import { ensureConversationMeta } from '../src/host/conversationStore.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { __clearAgentIdentityCache } from '../src/host/agentIdentity.js';
import type { RunRecord } from '../src/types.js';
import type { ResolvedAgentManifest } from '../src/executor/agentRegistry.js';

const { MOCK_REASONER } = vi.hoisted(() => ({ MOCK_REASONER: 'mock-reasoner' }));
vi.mock('../src/providers/catalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/catalog.js')>();
  return {
    ...actual,
    getClassDefault: (providerId: string, modelClass: string): string | null =>
      providerId === 'mock' && modelClass === 'reasoning' ? MOCK_REASONER : actual.getClassDefault(providerId, modelClass),
  };
});

let server: http.Server;
let BASE: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };
const TENANT = '_anon';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

const GROUP_REASONING = { conversationType: 'group', agentModelClass: 'reasoning' } as const;

describe('resolveConversationModelTarget — precedence + the same-provider bump', () => {
  const inputs = { provider: 'anthropic', model: 'claude-haiku-4-5' };

  it('group + reasoning + no stamp/override → bumps to the provider OWN class default', () => {
    const want = getClassDefault('anthropic', 'reasoning'); // providers.json classDefaults
    expect(want).not.toBeNull();
    expect(want).not.toBe(inputs.model); // or the bump would be indistinguishable from no bump
    const t = resolveConversationModelTarget({ runInputs: inputs, metadata: {}, tier: GROUP_REASONING });
    expect(t).toEqual({ provider: 'anthropic', model: want });
  });

  it('the bump NEVER crosses providers (google stays google)', () => {
    const t = resolveConversationModelTarget({ runInputs: { provider: 'google', model: 'gemini-3.1-flash-lite' }, metadata: {}, tier: GROUP_REASONING });
    expect(t.provider).toBe('google');
    expect(t.model).toBe(getClassDefault('google', 'reasoning'));
  });

  it('a stamped route wins over the bump (tenant rule > host default)', () => {
    const t = resolveConversationModelTarget({
      runInputs: inputs, metadata: { modelRoute: { provider: 'anthropic', model: 'claude-sonnet-4-6' } }, tier: GROUP_REASONING,
    });
    expect(t.model).toBe('claude-sonnet-4-6');
  });

  it('an exchange override wins over everything (the in-chat selector)', () => {
    const t = resolveConversationModelTarget({
      runInputs: inputs, metadata: { modelRoute: { provider: 'anthropic', model: 'claude-sonnet-4-6' } },
      override: { model: 'claude-haiku-4-5' }, tier: GROUP_REASONING,
    });
    expect(t.model).toBe('claude-haiku-4-5');
    // Override ALONE (no stamp) beats the bump too — the leg where the override is
    // the only thing that says "the model was chosen".
    const o = resolveConversationModelTarget({ runInputs: inputs, metadata: {}, override: { model: 'claude-haiku-4-5' }, tier: GROUP_REASONING });
    expect(o).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('no bump outside group rooms, for non-reasoning agents, or unknown providers', () => {
    expect(resolveConversationModelTarget({ runInputs: inputs, metadata: {}, tier: { conversationType: 'agent', agentModelClass: 'reasoning' } }).model).toBe('claude-haiku-4-5');
    expect(resolveConversationModelTarget({ runInputs: inputs, metadata: {}, tier: { conversationType: 'group', agentModelClass: 'chat' } }).model).toBe('claude-haiku-4-5');
    expect(resolveConversationModelTarget({ runInputs: { provider: 'no-such-provider', model: 'x-1' }, metadata: {}, tier: GROUP_REASONING }).model).toBe('x-1');
  });
});

describe('CS-GB-1 — tool-loop eligibility judges the RESOLVED provider', () => {
  const agent: ResolvedAgentManifest = { agentId: 'a', persona: 'p', modelClass: 'chat', systemPrompt: 's', toolAllowlist: [], packName: 'x', packVersion: '1' };
  const run = (provider: string, metadata?: Record<string, unknown>): RunRecord => ({
    runId: 'r', tenantId: TENANT, workflowId: 'w', status: 'waiting-input',
    inputs: { provider, model: 'm', credentialRef: 'byok-x' }, metadata: metadata ?? {}, configurable: {},
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('an in-chat override to a non-tool-calling provider disables the loop (and vice versa)', () => {
    expect(conversationToolTurnEligible(run('anthropic'), agent)).toBe(true);
    expect(conversationToolTurnEligible(run('anthropic'), agent, { provider: 'mock' })).toBe(false);
    expect(conversationToolTurnEligible(run('mock'), agent)).toBe(false);
    expect(conversationToolTurnEligible(run('mock'), agent, { provider: 'anthropic' })).toBe(true);
  });

  it('a stamped route reaches eligibility too', () => {
    expect(conversationToolTurnEligible(run('mock', { modelRoute: { provider: 'anthropic', model: 'claude-sonnet-4-6' } }), agent)).toBe(true);
  });
});

describe('CS-GB-2 — a board-group exchange dispatches the resolved model end-to-end', () => {
  it("a group conversation's reasoning agent turn carries the bump through provenance", async () => {
    // Register a reasoning-class agent + a group-typed conversation.
    getAgentRegistry().register({
      agentId: 'probe.csgb.reasoner', persona: 'Board Reasoner', modelClass: 'reasoning',
      systemPrompt: 'board reasoner probe', toolAllowlist: [], packName: 'test.csgb', packVersion: '0.0.1',
    });
    __clearAgentIdentityCache();
    await ensureConversationMeta(TENANT, 'conv-csgb-group', { type: 'group' });

    const workflowId = 'openwop-app.csgb.board-test';
    const reg = await fetch(`${BASE}/host/openwop-app/workflows`, {
      method: 'POST', headers: H, body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'x' } }], edges: [] }),
    });
    expect(reg.ok).toBe(true);
    const create = await fetch(`${BASE}/runs`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ workflowId, inputs: { provider: 'mock', model: 'mock-1' }, tenantId: TENANT, metadata: { chatSessionId: 'conv-csgb-group' } }),
    });
    expect(create.status).toBe(201);
    const { runId } = await create.json() as { runId: string };
    await vi.waitFor(async () => {
      const s = await (await fetch(`${BASE}/runs/${runId}`, { headers: H })).json() as { status: string };
      expect(s.status).toBe('waiting-input');
    }, { timeout: 5000, interval: 20 });
    const ex = await fetch(`${BASE}/runs/${runId}/interrupts/gate`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: '@probe.csgb.reasoner what next?', to: 'probe.csgb.reasoner' } } }),
    });
    expect(ex.status).toBe(200);
    const bundle = await (await fetch(`${BASE}/runs/${runId}/debug-bundle`, { headers: H })).json() as { events?: Array<{ type?: string; payload?: { turn?: { role?: string; agent?: { agentId?: string; model?: { model?: string; provider?: string } } } } }> };
    const agentTurns = (bundle.events ?? []).filter((e) => e.type === 'conversation.exchanged' && e.payload?.turn?.role === 'agent');
    // Exactly the one answer, attributed to the reasoner, stamped with the BUMPED
    // model on the run's OWN provider (mock-1 → the stubbed class default).
    expect(agentTurns).toHaveLength(1);
    expect(agentTurns[0]!.payload?.turn?.agent).toEqual({ agentId: 'probe.csgb.reasoner', model: { provider: 'mock', model: MOCK_REASONER } });
  });
});
