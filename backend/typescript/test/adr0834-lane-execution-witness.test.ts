/**
 * ADR 0834 D1 / FW2-CD-3 — EXECUTION witnesses for the two lanes the first witness file
 * did not drive end to end: the run lane (`agentRunnerNode`, every workflow / scheduled /
 * heartbeat agent turn) and the ad-hoc live dispatch route (`POST /host/openwop-app/agents/:id/dispatch`).
 *
 * The lane census proves each lane BUILDS and HANDS OFF its firewall; this proves the
 * decision is actually taken: with a platform `deny` on the write class, a tool the model
 * calls is refused and never executes. Each has a control (no rule ⇒ the same call runs),
 * so a green run cannot mean "the tool never ran for some other reason".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiToolCallRequest, AiToolCallResult, NodeContext } from '../src/executor/types.js';

const PROBE = 'openwop:adr0834.lane-probe';
const executed: string[] = [];
let round = 0;
/** Round 1 calls the probe; round 2 answers. */
const scriptedToolRound = async (_r: AiToolCallRequest): Promise<AiToolCallResult> => {
  round += 1;
  return round === 1 ? { content: '', toolCalls: [{ id: 'p1', name: PROBE, input: {} }] } : { content: 'done', toolCalls: [] };
};

vi.mock('../src/aiProviders/aiProvidersHost.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/aiProviders/aiProvidersHost.js')>();
  return {
    ...actual,
    createAiProvidersAdapter: (scope: Parameters<typeof actual.createAiProvidersAdapter>[0]) => ({
      ...actual.createAiProvidersAdapter(scope),
      callAI: async () => ({ data: 'done' }),
      callAIWithTools: scriptedToolRound,
    }),
  };
});

import { createApp } from '../src/index.js';
import agentRunnerNode from '../src/host/agentRunnerNode.js';
import { registerFeatureAgentTool } from '../src/host/agentToolProvider.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { __clearAgentIdentityCache } from '../src/host/agentIdentity.js';
import { setPlatformRules } from '../src/features/capability-firewall/ruleStore.js';
import type { CapabilityRule } from '../src/features/capability-firewall/types.js';

const DENY_WRITES: CapabilityRule = { id: 'deny-writes', description: '', when: { with: [{ safetyTier: 'write' }] }, verdict: 'deny', reason: 'platform deny' };
const AGENT = 'adr0834.lane-agent';

let BASE = '';
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  registerFeatureAgentTool({
    contentTrust: 'trusted', effect: 'write',
    def: { name: PROBE, description: 'ADR 0834 lane probe', inputSchema: { type: 'object' } },
    run: async () => { executed.push(PROBE); return { content: 'ran' }; },
  });
  getAgentRegistry().register({
    agentId: AGENT, persona: 'Lane', modelClass: 'chat', systemPrompt: 'p',
    toolAllowlist: [PROBE], packName: 'test.adr0834', packVersion: '0.0.1',
  });
  __clearAgentIdentityCache();
}, 120_000);
afterAll(async () => {
  await setPlatformRules([]);
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(() => { executed.length = 0; round = 0; });

async function runLane(): Promise<void> {
  const ctx = {
    tenantId: 'default', runId: `run-lane-${Math.random()}`, inputs: { agentId: AGENT, task: 'do it', credentialRef: 'managed:openwop-free' },
    config: { offerTools: [PROBE] }, configurable: {}, emit: async () => {},
    callAI: async () => ({ data: 'done' }), callAIWithTools: scriptedToolRound,
  } as unknown as NodeContext;
  await agentRunnerNode.execute(ctx);
}

async function dispatchLane(): Promise<number> {
  const res = await fetch(`${BASE}/host/openwop-app/agents/${encodeURIComponent(AGENT)}/dispatch`, {
    method: 'POST',
    headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    body: JSON.stringify({ live: true, task: 'do it', availableTools: [PROBE] }),
  });
  return res.status;
}

describe('run lane (agentRunnerNode) takes the firewall decision', () => {
  it('control: with no rule the model\'s call runs', async () => {
    await setPlatformRules([]);
    await runLane();
    expect(executed).toEqual([PROBE]);
  });
  it('a platform deny refuses it — the tool never executes', async () => {
    await setPlatformRules([DENY_WRITES]);
    await runLane();
    expect(executed).toEqual([]);
  });
});

describe('dispatch route (POST /host/openwop-app/agents/:id/dispatch live) takes the firewall decision', () => {
  it('control: with no rule the model\'s call runs', async () => {
    await setPlatformRules([]);
    expect(await dispatchLane()).toBe(200);
    expect(executed).toEqual([PROBE]);
  });
  it('a platform deny refuses it — the tool never executes', async () => {
    await setPlatformRules([DENY_WRITES]);
    expect(await dispatchLane()).toBe(200);
    expect(executed).toEqual([]);
  });
});
