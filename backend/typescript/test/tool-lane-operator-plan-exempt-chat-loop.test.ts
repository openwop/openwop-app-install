/**
 * ADR 1108 — the chat tool loop carries an operator-stamped conversation's plan
 * exemption ONLY to the operator's own turns.
 *
 * The exemption is borrowed authority, like a `bypass` (ADR 0834 D3): tools in
 * a shared conversation act as the run's acting principal, whoever posted. A
 * participant (a customer) posting into the operator's conversation in the
 * customer's free workspace must not spend the operator's exemption on
 * paywalled tools — priced ⟹ gated. Neither does a channel-ingress turn.
 *
 * Real seam: `runConversationAgentToolTurn` reading `run.metadata` (not a
 * hand-built scope). The model is the managed lane, mocked to call one probe
 * tool that runs the real Campaign Brief `get-brief` tool with the scope the
 * loop composed, so the observed result is the real gate's answer.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let managedRound = 0;
vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return {
    ...actual,
    dispatchManagedToolsRound: vi.fn(async () => {
      managedRound += 1;
      if (managedRound === 1) return { text: '', toolUses: [{ id: 'c1', name: PROBE, input: {} }] };
      return { text: 'done', toolUses: [] };
    }),
  };
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerFeatureAgentTool } from '../src/host/agentToolProvider.js';
import { runConversationAgentToolTurn } from '../src/host/conversationToolLoop.js';
import { runGetBriefTool } from '../src/features/campaign-brief/agentTools.js';
import type { ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';
import type { RunRecord } from '../src/types.js';

const PROBE = 'openwop:adr1108.probe-get-brief';
const OPERATOR_PERSONAL = 'user:operator-loop-0001';
const FREE_WS = 'ws:free-loop-0001';
const OPERATOR = 'operator-loop';
const ENV = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_AUTH_DISABLE_COOKIES: 'true',
  OPENWOP_SUPERADMIN_TENANTS: OPERATOR_PERSONAL,
  OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_mktg: 'marketing' }),
  OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify({ free: ['billing'], pro: ['billing'] }),
};
const saved: Record<string, string | undefined> = {};
let server: http.Server;
const results: Array<{ content: string; isError?: boolean }> = [];

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  for (const id of ['campaign-brief', 'billing']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  registerFeatureAgentTool({
    contentTrust: 'trusted', effect: 'read',
    def: { name: PROBE, description: 'ADR 1108 probe: the real get-brief with the loop scope', inputSchema: { type: 'object' } },
    run: async (_input, scope) => { const r = await runGetBriefTool({ briefId: 'cb-missing' }, scope); results.push(r); return r; },
  });
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

const agent: ResolvedAgentManifest = {
  agentId: 'adr1108-agent', persona: 'P', modelClass: 'chat', systemPrompt: 'sp', toolAllowlist: [PROBE],
  packName: 'test.adr1108', packVersion: '0.0.1',
};
const noPolicies: ProviderPolicyResolver = { resolveForRun: async () => [] };
const AT = '2026-01-01T00:00:00.000Z';
let n = 0;
/** An operator-started conversation run in the customer's free workspace, stamped as POST /runs would. */
function operatorConversation(extra: Record<string, unknown> = {}): RunRecord {
  n += 1;
  return {
    runId: `r-1108-loop-${n}`, workflowId: 'adr1108.chat', tenantId: FREE_WS, status: 'running',
    inputs: { credentialRef: 'managed:openwop-free' },
    metadata: { actingUserId: OPERATOR, personalTenant: OPERATOR_PERSONAL, planExempt: true, chatSessionId: `sess-1108-${n}`, ...extra },
    configurable: {}, createdAt: AT, updatedAt: AT,
  };
}
async function turn(run: RunRecord, callerPrincipal: string | undefined): Promise<{ error?: string; brief?: unknown }> {
  managedRound = 0; results.length = 0;
  await runConversationAgentToolTurn({
    run, agent, systemPrompt: 'sp', history: [{ role: 'user', content: 'read the brief' }],
    runId: run.runId, nodeId: 'n', conversationId: `${run.runId}:n:0`, policyResolver: noPolicies,
    ...(callerPrincipal ? { callerPrincipal } : {}),
  });
  expect(results, 'the probe tool ran').toHaveLength(1);
  return JSON.parse(results[0]!.content) as { error?: string; brief?: unknown };
}

describe('chat loop — whose turn spends the operator exemption', () => {
  it('the operator\'s own turn passes the plan gate', async () => {
    const out = await turn(operatorConversation(), OPERATOR);
    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({ brief: null });
  });

  it('a PARTICIPANT\'s turn in the operator\'s conversation is refused on the plan', async () => {
    expect((await turn(operatorConversation(), 'customer-loop')).error).toBe('not_entitled');
  });

  it('a turn with no caller principal is refused on the plan', async () => {
    expect((await turn(operatorConversation(), undefined)).error).toBe('not_entitled');
  });

  it('a channel-ingress turn is refused on the plan, even as the owner', async () => {
    expect((await turn(operatorConversation({ channelIngress: { scope: 'full' } }), OPERATOR)).error).toBe('not_entitled');
  });
});
