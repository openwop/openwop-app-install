/**
 * TOC2CD-11 (review M3) — the provenance flags survive BOTH model-facing lanes end
 * to end. The unit cases call `toModelToolResult` directly; these run a real
 * `runChatToolLoop` round and a real `executeRealtimeToolCall`, so dropping the
 * flag spread at either call site turns a case red.
 *
 * Sabotage witnessed 2026-10-28:
 *  - drop `...(execOut.hostMessage ? { hostVouched: true } : {})` in agentDispatch → chat "vouched" case.
 *  - drop `...(out.hostMessage ? { hostVouched: true } : {})` in toolBridge → voice "vouched" case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { registerFeatureAgentTool } from '../src/host/agentToolProvider.js';
import { toolError } from '../src/host/agentToolKit.js';
import { runChatToolLoop, type CompiledTool } from '../src/host/agentDispatch.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';
import { executeRealtimeToolCall } from '../src/features/voice/realtime/toolBridge.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { __clearAgentIdentityCache } from '../src/host/agentIdentity.js';

const VOUCHED = 'openwop:toc2cd11-lanes.vouched';
const AGENT = 'probe.toc2cd11.lanes';
const HOST_REFUSAL = toolError('org_required', 'This workspace has 2 organizations — pass `orgId` (ask the user which).');
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // UNTRUSTED on purpose: only the provenance flag can keep its refusal unfenced.
  registerFeatureAgentTool({
    contentTrust: 'untrusted', effect: 'read',
    def: { name: VOUCHED, description: 'refuses with a host sentence', inputSchema: { type: 'object' } },
    run: async () => HOST_REFUSAL,
  });
  getAgentRegistry().register({
    agentId: AGENT, persona: 'Lanes Probe', modelClass: 'chat', systemPrompt: 'probe',
    toolAllowlist: [VOUCHED], packName: 'test.toc2cd11-lanes', packVersion: '0.0.1',
  });
  __clearAgentIdentityCache();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('TOC2CD-11 — chat lane (runChatToolLoop with the real provider)', () => {
  async function lastToolMessage(tool: string): Promise<string> {
    const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
    const { executeTool } = createAgentToolProvider({ tenantId: 't1', runId: 'r1' } as never);
    const compiled: CompiledTool = { def: { name: tool, description: 'd', inputSchema: { type: 'object' } }, validate: () => ({ ok: true }) };
    const seen: AiToolCallRequest[] = [];
    let round = 0;
    const callAIWithTools = async (r: AiToolCallRequest): Promise<AiToolCallResult> => {
      seen.push(r);
      round += 1;
      return round === 1 ? { content: '', toolCalls: [{ id: 'c1', name: tool, input: {} }] } : { content: 'ok', toolCalls: [] };
    };
    await runChatToolLoop(
      { provider: 'p', model: 'm', credentialRef: 'r', systemPrompt: 'sp', messages: [{ role: 'user' as const, content: 'go' }], tools: [compiled], agentId: 'a', persona: 'P' },
      { callAIWithTools, executeTool },
    );
    const last = [...seen[1]!.messages].reverse().find((m) => m.role === 'user');
    return typeof last?.content === 'string' ? last.content : '';
  }

  it('a vouched host refusal from an untrusted tool reaches the model unchanged', async () => {
    expect(await lastToolMessage(VOUCHED)).toBe(`Result of ${VOUCHED}: ${HOST_REFUSAL.content}`);
  });

});

describe('TOC2CD-11 — realtime voice lane (executeRealtimeToolCall)', () => {
  const call = (name: string) => executeRealtimeToolCall({ tenantId: 'default', agentId: AGENT, sessionId: `s-${name}`, name, args: {} });

  it('a vouched host refusal from an untrusted tool reaches the voice model unchanged', async () => {
    const out = await call(VOUCHED);
    expect(out).toMatchObject({ status: 'ok', isError: true, result: HOST_REFUSAL.content });
  });

});
