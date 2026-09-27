/**
 * ADR 0397 Phase 1 + 4 — the firewall verdict → loop integration.
 *
 * Drives `runChatToolLoop` with a stub model that calls one tool and a firewall hook
 * whose verdict we control, and asserts the loop wiring:
 *  - a `require-approval` verdict (rule-driven OR the deny-mode fall-through — identical to
 *    the loop) does NOT execute the tool, collects a pending approval, and fires
 *    `onFirewallDecision` (P1 observability);
 *  - a `deny` verdict is forbidden and also observed;
 *  - an `allow` verdict executes the tool and fires NO decision record (no noise).
 */
import { describe, it, expect } from 'vitest';
import { runChatToolLoop, type CompiledTool, type ChatToolLoopOpts } from '../agentDispatch.js';
import type { AiToolCallResult } from '../../executor/types.js';

const TOOL = 'core.openwop.integration.email-send';
const tool: CompiledTool = { def: { name: TOOL, description: 'send', inputSchema: { type: 'object' } }, validate: () => ({ ok: true }) };

/** A stub model: round 1 calls the tool once; round 2 answers (ends the loop). */
function stubModel(): () => Promise<AiToolCallResult> {
  let round = 0;
  return async () => {
    round += 1;
    if (round === 1) return { toolCalls: [{ id: 'c1', name: TOOL, input: {} }] };
    return { content: 'done', toolCalls: [] };
  };
}

function baseOpts(firewallDecision: 'allow' | 'deny' | 'require-approval', sink: unknown[]): ChatToolLoopOpts {
  return {
    provider: 'anthropic', model: 'claude-x', credentialRef: 'k', systemPrompt: 's',
    messages: [{ role: 'user', content: 'go' }],
    tools: [tool], agentId: 'a1', persona: 'Tester',
    firewall: { evaluate: () => ({ decision: firewallDecision, reason: 'r', ...(firewallDecision !== 'allow' ? { ruleId: 'rule-x' } : {}) }) },
    onFirewallDecision: (d) => sink.push(d),
  };
}

describe('firewall → runChatToolLoop integration (ADR 0397 P1/P4)', () => {
  it('require-approval: tool not executed, pending approval collected, decision recorded', async () => {
    const sink: unknown[] = [];
    let executed = 0;
    const res = await runChatToolLoop(baseOpts('require-approval', sink), {
      callAIWithTools: stubModel(),
      executeTool: async () => { executed += 1; return { content: 'sent' }; },
    });
    expect(executed).toBe(0);
    expect(res.pendingApprovals?.map((p) => p.toolName)).toEqual([TOOL]);
    expect(sink).toEqual([{ toolName: TOOL, decision: 'require-approval', reason: 'r', ruleId: 'rule-x' }]);
  });

  it('deny: tool not executed and the deny is recorded', async () => {
    const sink: unknown[] = [];
    let executed = 0;
    await runChatToolLoop(baseOpts('deny', sink), {
      callAIWithTools: stubModel(),
      executeTool: async () => { executed += 1; return { content: 'sent' }; },
    });
    expect(executed).toBe(0);
    expect(sink).toEqual([{ toolName: TOOL, decision: 'deny', reason: 'r', ruleId: 'rule-x' }]);
  });

  it('allow: tool executes and NO decision is recorded (no noise)', async () => {
    const sink: unknown[] = [];
    let executed = 0;
    await runChatToolLoop(baseOpts('allow', sink), {
      callAIWithTools: stubModel(),
      executeTool: async () => { executed += 1; return { content: 'sent' }; },
    });
    expect(executed).toBe(1);
    expect(sink).toEqual([]);
  });
});
