/**
 * ADR 0132 Phase 2 — the loop hook (the fourth AND-term). Exercises
 * `runChatToolLoop` with a `capabilityScope`: the model is offered only enabled
 * tools, and a forced/hallucinated call to a disabled-but-permitted tool is refused
 * (`agent.toolReturned{status:'forbidden'}`) before it executes.
 */
import { describe, it, expect } from 'vitest';
import { runChatToolLoop, type CompiledTool, type ChatToolLoopOpts } from '../src/host/agentDispatch.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

function tool(name: string): CompiledTool {
  return {
    def: { name, description: name, inputSchema: { type: 'object', additionalProperties: true } },
    validate: () => ({ ok: true }),
  };
}

const TOOLS = [tool('kb.search'), tool('email.draft'), tool('crm.contact.update')];

/** A scripted model: round 1 calls `forcedCall`, round 2 produces a final answer.
 *  Also records which tool defs it was OFFERED so we can assert the narrowing. */
function scriptedModel(forcedCall: string) {
  const offered: string[][] = [];
  const callAIWithTools = async (r: AiToolCallRequest): Promise<AiToolCallResult> => {
    offered.push(r.tools.map((t) => t.name));
    if (offered.length === 1) return { content: '', toolCalls: [{ id: '1', name: forcedCall, input: {} }] };
    return { content: 'done', toolCalls: [] };
  };
  return { callAIWithTools, offered };
}

const executed: string[] = [];
const executeTool = async (c: { name: string; input: Record<string, unknown> }) => {
  executed.push(c.name);
  return { content: `ran ${c.name}` };
};

function baseOpts(extra: Partial<ChatToolLoopOpts>): ChatToolLoopOpts {
  return {
    provider: 'p', model: 'm', credentialRef: 'byok:k',
    systemPrompt: 'sp', messages: [{ role: 'user', content: 'hi' }],
    tools: TOOLS, agentId: 'a', persona: 'Tester', maxRounds: 3,
    ...extra,
  };
}

describe('runChatToolLoop capability scope (ADR 0132 P2)', () => {
  it('offers ONLY the enabled tools to the model', async () => {
    executed.length = 0;
    const m = scriptedModel('kb.search');
    await runChatToolLoop(
      baseOpts({ capabilityScope: { enabled: ['kb.search'], requireApproval: [] } }),
      { callAIWithTools: m.callAIWithTools, executeTool },
    );
    expect(m.offered[0]).toEqual(['kb.search']); // email.draft + crm.* withheld
    expect(executed).toEqual(['kb.search']);     // the enabled call ran
  });

  it('REFUSES a forced call to a disabled-but-permitted tool (never executes it)', async () => {
    executed.length = 0;
    const m = scriptedModel('crm.contact.update'); // not in the enabled set
    const res = await runChatToolLoop(
      baseOpts({ capabilityScope: { enabled: ['kb.search'], requireApproval: [] } }),
      { callAIWithTools: m.callAIWithTools, executeTool },
    );
    expect(executed).not.toContain('crm.contact.update'); // forbidden before execution
    const forbidden = res.events.find((e) => e.type === 'agent.toolReturned' && e.toolName === 'crm.contact.update');
    expect(forbidden).toMatchObject({ status: 'forbidden' });
  });

  it('no capabilityScope ⇒ the full tool surface is offered (unchanged path)', async () => {
    executed.length = 0;
    const m = scriptedModel('crm.contact.update');
    await runChatToolLoop(baseOpts({}), { callAIWithTools: m.callAIWithTools, executeTool });
    expect(m.offered[0]).toEqual(['kb.search', 'email.draft', 'crm.contact.update']);
    expect(executed).toEqual(['crm.contact.update']); // executes — no narrowing
  });
});
