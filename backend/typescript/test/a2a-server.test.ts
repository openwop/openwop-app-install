/**
 * A7 — real A2A server handler (RFC 0076). Discovery (agent/getCard) +
 * message/send routed to a real manifest-agent dispatch + error mapping.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { handleA2aRequest, type A2aJsonRpcRequest } from '../src/host/a2aServer.js';

const CARD = { name: 'Sample Host', url: 'https://example.com/a2a', skills: [] };

function send(method: string, params?: Record<string, unknown>): A2aJsonRpcRequest {
  return { jsonrpc: '2.0', id: 1, method, params };
}

afterEach(() => getAgentRegistry()._resetForTest());

describe('A2A server (A7 / RFC 0076)', () => {
  it('serves the agent card on agent/getCard', () => {
    const res = handleA2aRequest(send('agent/getCard'), { agentCard: CARD });
    expect(res.result).toEqual(CARD);
  });

  it('routes message/send to a real manifest-agent dispatch', () => {
    getAgentRegistry().register({
      agentId: 'peer.agent',
      persona: 'Peer',
      modelClass: 'general',
      systemPrompt: 'Respond.',
      packName: 'test',
      packVersion: '0',
      toolAllowlist: [],
      confidence: { defaultThreshold: 0.5 },
    });
    const res = handleA2aRequest(
      send('message/send', { agentId: 'peer.agent', message: { parts: [{ kind: 'text', text: 'hello' }] } }),
      { agentCard: CARD },
    );
    const task = res.result as { kind: string; status: { state: string }; agentId: string };
    expect(task.kind).toBe('task');
    expect(task.status.state).toBe('completed');
    expect(task.agentId).toBe('peer.agent');
  });

  it('maps an unknown agent to a JSON-RPC error', () => {
    const res = handleA2aRequest(send('message/send', { agentId: 'nope.absent', message: { parts: [] } }), { agentCard: CARD });
    expect(res.error?.code).toBe(-32001);
  });

  it('rejects an unknown method and a missing agentId', () => {
    expect(handleA2aRequest(send('frobnicate'), { agentCard: CARD }).error?.code).toBe(-32601);
    expect(handleA2aRequest(send('message/send', { message: { parts: [] } }), { agentCard: CARD }).error?.code).toBe(-32602);
  });
});
