/**
 * ADR 1001 — the findings of the final-head /architect and /code-review pass
 * (2026-10-29) and the ADR 1006 tool-lane follow-ups, each pinned at the unit it
 * lives in.
 *
 *  1. A tool the firewall HELD earlier in a turn is not dropped when the same
 *     turn then asks a clarification: the loop returns BOTH the held tool and the
 *     pending ask (ADR 0150). The caller's escalate-first ordering lives in
 *     `runAgentDispatch` and is not asserted here.
 *  2. A turn that offers NO tools (a no-tool agent that may still ask) sends no
 *     `tools` / `tool_choice` to the OpenAI-compatible or Anthropic APIs, which
 *     refuse `tool_choice` without tools.
 *  3. `ClarificationData.contextType` reaches the wire `interrupt.requested`,
 *     and the host's routing keys (`__causationId`, `__durable`) do not, even on
 *     the custom fallback that copies `data`.
 *  4. The inbox row of an agent's ask shows its first question.
 *  5. A mixed round ends on the ask: the earlier call runs, the later one is
 *     recorded forbidden and never executes, tool output before the ask marks it
 *     untrusted, and the checkpointed transcript holds the ask text.
 *  6. Anthropic receives `openwop:ask-user` sanitized and the call comes back
 *     under the real id.
 *
 * Sabotage-witnessed (wave 81): dropping `pendingApprovals` from the loop's
 * clarification return reds 1; sending `tools`/`tool_choice` unconditionally
 * (OpenAI) or `tools` (Anthropic) reds 2; dropping `contextType` from the
 * projector, or `__causationId` / `__durable` from `hostData`, reds 3; reading
 * only `data.question` reds 4; disarming the ended-turn branch, dropping
 * `toolOutputSeen` from `untrusted`, or not pushing the ask text reds 5; sending
 * the raw name or not mapping it back reds 6.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runChatToolLoop, type CompiledTool } from '../src/host/agentDispatch.js';
import { dispatchOpenAIToolsRound } from '../src/providers/dispatchProviderTools.js';
import { dispatchAnthropicToolsRound } from '../src/providers/dispatchAnthropicTools.js';
import { buildInterruptRequestedPayload } from '../src/executor/interruptRequestedPayload.js';
import { interruptAnswerForm } from '../src/host/reviewProjection.js';
import { ASK_USER_TOOL } from '../src/host/clarificationLift.js';
import type { AiToolCallResult } from '../src/executor/types.js';
import type { InterruptRecord } from '../src/types.js';

const askCall = { id: 'ask', name: ASK_USER_TOOL, input: { questions: [{ id: 'q', question: 'Which?' }] } };

afterEach(() => { vi.unstubAllGlobals(); });

describe('1. a firewall-held tool survives a later clarification in the same turn', () => {
  it('returns the held tool with the pending clarification', async () => {
    const tool: CompiledTool = { def: { name: 'send.email', description: 'send', inputSchema: { type: 'object' } }, validate: () => ({ ok: true }) };
    let round = 0;
    const res = await runChatToolLoop(
      {
        provider: 'p', model: 'm', credentialRef: 'r', systemPrompt: 's', messages: [{ role: 'user', content: 'go' }],
        tools: [tool], agentId: 'a', persona: 'P', maxRounds: 5,
        firewall: { evaluate: () => ({ decision: 'require-approval', reason: 'egress' }) },
        clarification: { roundsUsed: 0, cap: 5, runId: 'r1', nodeId: 'n1', untrusted: false },
      },
      {
        callAIWithTools: async (): Promise<AiToolCallResult> => {
          round += 1;
          return round === 1 ? { content: '', toolCalls: [{ id: 't1', name: 'send.email', input: {} }] } : { content: '', toolCalls: [askCall] };
        },
        executeTool: async () => { throw new Error('a held tool must not execute'); },
      },
    );
    expect(res.pendingClarification?.round).toBe(1);
    expect(res.pendingApprovals?.map((p) => p.toolName)).toEqual(['send.email']);
  });
});

describe('2. a no-tool turn sends no tool list', () => {
  function capture(): { bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
        usage: { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    return { bodies };
  }
  const req = { model: 'm', apiKey: 'k', messages: [{ role: 'user' as const, content: 'hi' }], tools: [] };

  it('OpenAI-compatible: no `tools`, no `tool_choice`', async () => {
    const { bodies } = capture();
    await dispatchOpenAIToolsRound(req);
    expect(bodies[0]).toBeDefined();
    expect(bodies[0]).not.toHaveProperty('tools');
    expect(bodies[0]).not.toHaveProperty('tool_choice');
  });

  it('Anthropic: no `tools`', async () => {
    const { bodies } = capture();
    await dispatchAnthropicToolsRound(req);
    expect(bodies[0]).toBeDefined();
    expect(bodies[0]).not.toHaveProperty('tools');
  });
});

describe('3. the wire projection of an agent ask', () => {
  it('carries contextType and none of the host routing keys', () => {
    const p = buildInterruptRequestedPayload({
      runId: 'r', nodeId: 'n', kind: 'clarification',
      data: {
        profile: 'openwop-agent-clarification', questions: [{ id: 'q', question: 'Which?' }], contextType: 'form-field',
        __causationId: 'r:n:clarify:1', __durable: true, __resumeKey: 'clarify:1:abc', askedBy: 'Iris', round: 1,
      },
    });
    expect(p.data).toEqual({ questions: [{ id: 'q', question: 'Which?' }], contextType: 'form-field' });
  });

  it('keeps the host routing keys off the wire even on the custom fallback, which copies data', () => {
    const p = buildInterruptRequestedPayload({
      runId: 'r', nodeId: 'n', kind: 'clarification',
      data: { questions: [], note: 'x', __causationId: 'r:n:clarify:1', __durable: true },
    });
    expect(JSON.stringify(p)).toContain('"note":"x"');
    expect(JSON.stringify(p)).not.toContain('__causationId');
    expect(JSON.stringify(p)).not.toContain('__durable');
  });
});

describe('4. the inbox row of an agent ask', () => {
  it('shows the first question', () => {
    const rec: InterruptRecord = {
      interruptId: 'i', runId: 'r', nodeId: 'n', kind: 'clarification', token: 't', createdAt: '2026-10-29T00:00:00Z',
      data: { profile: 'openwop-agent-clarification', questions: [{ id: 'q', question: 'Which region?' }] },
    };
    const form = interruptAnswerForm(rec);
    expect(form?.question).toBe('Which region?');
  });
});

describe('5. a mixed round ends on the ask', () => {
  it('records the earlier call as run, the ask as ok and the later call as forbidden, and never executes the later call', async () => {
    const tool: CompiledTool = { def: { name: 'read.doc', description: 'read', inputSchema: { type: 'object' } }, validate: () => ({ ok: true }) };
    const ran: unknown[] = [];
    const res = await runChatToolLoop(
      {
        provider: 'p', model: 'm', credentialRef: 'r', systemPrompt: 's', messages: [{ role: 'user', content: 'go' }],
        tools: [tool], agentId: 'a', persona: 'P', maxRounds: 5,
        clarification: { roundsUsed: 0, cap: 5, runId: 'r1', nodeId: 'n1', untrusted: false },
      },
      {
        callAIWithTools: async (): Promise<AiToolCallResult> => ({
          content: '',
          toolCalls: [{ id: 't1', name: 'read.doc', input: { n: 1 } }, askCall, { id: 't2', name: 'read.doc', input: { n: 2 } }],
        }),
        executeTool: async (c) => { ran.push(c.input); return { content: 'ok' }; },
      },
    );
    expect(ran).toEqual([{ n: 1 }]);
    expect(res.pendingClarification?.round).toBe(1);
    // Tool output came before the ask, so its question is restricted (ADR 1001 D4).
    expect(res.pendingClarification?.untrusted).toBe(true);
    const returned = res.events.flatMap((e) => (e.type === 'agent.toolReturned' ? [[e.toolName, e.status]] : []));
    expect(returned).toEqual([['read.doc', 'ok'], [ASK_USER_TOOL, 'ok'], ['read.doc', 'forbidden']]);
    const said = res.pendingClarification?.messages ?? [];
    expect(JSON.stringify(said)).toContain('Tool \\"read.doc\\" was not run');
    // The checkpointed transcript holds the ask, so the model can read the
    // answer against its own question after a resume.
    expect(said.find((m) => m.role === 'assistant')?.content).toBe('Which?');
  });
});

describe('6. a provider-sanitized name comes back as the tool id', () => {
  it('Anthropic: `openwop:ask-user` is sent sanitized and the call returns under the real id', async () => {
    const bodies: Array<{ tools?: Array<{ name: string }> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as { tools?: Array<{ name: string }> });
      return new Response(JSON.stringify({
        content: [{ type: 'tool_use', id: 'c1', name: 'openwop_ask-user', input: { questions: [{ id: 'q', question: 'Which?' }] } }],
        stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const out = await dispatchAnthropicToolsRound({
      model: 'm', apiKey: 'k', messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: ASK_USER_TOOL, description: 'ask', inputSchema: { type: 'object' } }],
    });
    expect(bodies[0]?.tools?.map((t) => t.name)).toEqual(['openwop_ask-user']);
    expect(out.toolUses.map((t) => t.name)).toEqual([ASK_USER_TOOL]);
  });
});
