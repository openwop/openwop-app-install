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
 *  - a real board-group exchange dispatches the bumped model end-to-end
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
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
    const t = resolveConversationModelTarget({ runInputs: inputs, metadata: {}, tier: GROUP_REASONING });
    expect(t).toEqual({ provider: 'anthropic', model: 'claude-opus-5' }); // classDefaults
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
  });

  it('no bump outside group rooms, for non-reasoning agents, or unknown providers', () => {
    expect(resolveConversationModelTarget({ runInputs: inputs, metadata: {}, tier: { conversationType: 'agent', agentModelClass: 'reasoning' } }).model).toBe('claude-haiku-4-5');
    expect(resolveConversationModelTarget({ runInputs: inputs, metadata: {}, tier: { conversationType: 'group', agentModelClass: 'chat' } }).model).toBe('claude-haiku-4-5');
    expect(resolveConversationModelTarget({ runInputs: { provider: 'mock', model: 'mock-1' }, metadata: {}, tier: GROUP_REASONING }).model).toBe('mock-1');
  });
});

describe('CS-GB-1 — tool-loop eligibility judges the RESOLVED provider', () => {
  const agent = { agentId: 'a', persona: 'p', modelClass: 'chat', systemPrompt: 's', toolAllowlist: [], packName: 'x', packVersion: '1' } as unknown as ResolvedAgentManifest;
  const run = (provider: string, metadata?: Record<string, unknown>): RunRecord =>
    ({ runId: 'r', tenantId: TENANT, workflowId: 'w', status: 'waiting_input', inputs: { provider, model: 'm', credentialRef: 'byok-x' }, metadata: metadata ?? {}, configurable: {}, createdAt: '', updatedAt: '' } as unknown as RunRecord);

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
  it("a group conversation's reasoning agent turn carries the bump through provenance (mock provider = no classDefaults = passthrough)", async () => {
    // Register a reasoning-class agent + a group-typed conversation.
    getAgentRegistry().register({
      agentId: 'probe.csgb.reasoner', persona: 'Board Reasoner', modelClass: 'reasoning',
      systemPrompt: 'board reasoner probe', toolAllowlist: [], packName: 'test.csgb', packVersion: '0.0.1',
    });
    __clearAgentIdentityCache();
    await ensureConversationMeta(TENANT, 'conv-csgb-group', { type: 'group' });

    const workflowId = 'openwop-app.csgb.board-test';
    await fetch(`${BASE}/v1/host/openwop-app/workflows`, {
      method: 'POST', headers: H, body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'x' } }], edges: [] }),
    });
    const create = await fetch(`${BASE}/v1/runs`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ workflowId, inputs: { provider: 'mock', model: 'mock-1' }, tenantId: TENANT, metadata: { chatSessionId: 'conv-csgb-group' } }),
    });
    expect(create.status).toBe(201);
    const { runId } = await create.json() as { runId: string };
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const s = await (await fetch(`${BASE}/v1/runs/${runId}`, { headers: H })).json() as { status: string };
      if (s.status.startsWith('waiting')) break;
    }
    const ex = await fetch(`${BASE}/v1/runs/${runId}/interrupts/gate`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: '@probe.csgb.reasoner what next?', to: 'probe.csgb.reasoner' } } }),
    });
    expect(ex.status).toBe(200);
    // mock has no classDefaults → the dispatched/provenance model stays mock-1
    // (proves the bump is catalog-driven and never invents a model).
    const bundle = await (await fetch(`${BASE}/v1/runs/${runId}/debug-bundle`, { headers: H })).json() as { events?: Array<{ type?: string; payload?: { turn?: { agent?: { model?: { model?: string; provider?: string } } } } }> };
    const agentTurn = (bundle.events ?? []).find((e) => e.type === 'conversation.exchanged' && e.payload?.turn?.agent?.model);
    if (agentTurn) {
      expect(agentTurn.payload?.turn?.agent?.model?.model).toBe('mock-1');
      expect(agentTurn.payload?.turn?.agent?.model?.provider).toBe('mock');
    }
  });
});
