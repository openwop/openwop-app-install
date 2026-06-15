/**
 * core.conversationGate — open + suspend contract (RFC 0005, MAS Phase 4).
 *
 * The gate OPENS a conversation: mints a deterministic conversationId, emits
 * `conversation.opened` (turnIndex 0), and suspends with interrupt kind
 * `conversation`. Exchanges/close are driven through the resolve path (tested
 * end-to-end elsewhere); here we pin the node's open contract.
 */
import { describe, it, expect } from 'vitest';
import { conversationGateNode } from '../src/bootstrap/nodes.js';
import { conversationIdFor, turnMessageId, type ConversationTurn } from '../src/host/conversation.js';
import type { NodeContext } from '../src/executor/types.js';

interface Captured { type: string; payload: unknown }

function makeCtx(config: Record<string, unknown> = {}): { ctx: NodeContext; events: Captured[] } {
  const events: Captured[] = [];
  let seq = 1;
  const ctx: NodeContext = {
    runId: 'run-conv', nodeId: 'gate-1', tenantId: 't1', inputs: {}, config,
    configurable: {}, attempt: 1, secrets: {},
    async emit(type, payload) { const eventId = `e${seq}`; const sequence = seq++; events.push({ type, payload }); return { eventId, sequence }; },
  } as NodeContext;
  return { ctx, events };
}

describe('core.conversationGate — open', () => {
  it('emits conversation.opened (turnIndex 0) and suspends with kind "conversation"', async () => {
    const { ctx, events } = makeCtx({ prompt: 'How can the team help?' });
    const out = await conversationGateNode.execute(ctx);

    // Suspends as a conversation interrupt.
    expect(out.status).toBe('suspended');
    if (out.status !== 'suspended') throw new Error('unreachable');
    expect(out.interrupt.kind).toBe('conversation');
    const data = out.interrupt.data as { conversationId: string; turnIndex: number };
    const expectedId = conversationIdFor('run-conv', 'gate-1');
    expect(data.conversationId).toBe(expectedId);
    expect(data.turnIndex).toBe(0);

    // Emits exactly one conversation.opened with a turnIndex-0 system initialTurn.
    const opened = events.filter((e) => e.type === 'conversation.opened');
    expect(opened).toHaveLength(1);
    const p = opened[0]!.payload as { conversationId: string; initialTurn: ConversationTurn; capabilities?: string[] };
    expect(p.conversationId).toBe(expectedId);
    expect(p.initialTurn.turnIndex).toBe(0);
    expect(p.initialTurn.role).toBe('system');
    expect(p.initialTurn.messageId).toBe(turnMessageId(expectedId, 0, 'system'));
    expect(p.initialTurn.content).toBe('How can the team help?');
    expect(p.capabilities).toContain('multi-turn');
  });

  it('passes a per-turn schema through to resumeSchema + the opened event', async () => {
    const schema = { type: 'object', properties: { text: { type: 'string' } } };
    const { ctx, events } = makeCtx({ schema });
    const out = await conversationGateNode.execute(ctx);
    if (out.status !== 'suspended') throw new Error('unreachable');
    expect(out.interrupt.resumeSchema).toEqual(schema);
    const p = events.find((e) => e.type === 'conversation.opened')!.payload as { schema?: unknown };
    expect(p.schema).toEqual(schema);
  });
});
