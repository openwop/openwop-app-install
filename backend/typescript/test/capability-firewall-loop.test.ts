/**
 * ADR 0135 Phase 2 — the firewall hook wired into runChatToolLoop: a read-then-egress
 * combination within a turn is deferred (require-approval), a deny verdict is forbidden,
 * and an already-approved tool short-circuits.
 */
import { describe, it, expect } from 'vitest';
import { runChatToolLoop, type CompiledTool, type ChatToolLoopOpts } from '../src/host/agentDispatch.js';
import { buildFirewallHook, recommendedExfilRule } from '../src/features/capability-firewall/firewallHook.js';
import type { CapabilityRule } from '../src/features/capability-firewall/types.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

const READ = 'openwop:knowledge.search';            // classified read
const EGRESS = 'core.openwop.integration.email-send'; // classified write+host-mediated egress
function tool(name: string): CompiledTool {
  return { def: { name, description: name, inputSchema: { type: 'object', additionalProperties: true } }, validate: () => ({ ok: true }) };
}
const TOOLS = [tool(READ), tool(EGRESS)];

const executed: string[] = [];
const executeTool = async (c: { name: string }) => { executed.push(c.name); return { content: `ran ${c.name}` }; };

/** Scripted model: calls `seq` in order across rounds, then stops. */
function scripted(seq: string[]) {
  let i = 0;
  return async (_r: AiToolCallRequest): Promise<AiToolCallResult> =>
    i < seq.length ? { content: '', toolCalls: [{ id: String(i), name: seq[i++]!, input: {} }] } : { content: 'done', toolCalls: [] };
}
function opts(extra: Partial<ChatToolLoopOpts>): ChatToolLoopOpts {
  return { provider: 'p', model: 'm', credentialRef: 'byok:k', systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, agentId: 'a', persona: 'P', maxRounds: 5, ...extra };
}

describe('capability firewall in runChatToolLoop (ADR 0135 P2)', () => {
  it('read then egress in one turn ⇒ the egress is DEFERRED (require-approval), not executed', async () => {
    executed.length = 0;
    const firewall = buildFirewallHook({ rules: [recommendedExfilRule()] });
    const res = await runChatToolLoop(opts({ firewall }), { callAIWithTools: scripted([READ, EGRESS]), executeTool });
    expect(executed).toEqual([READ]);                 // the read ran
    expect(executed).not.toContain(EGRESS);           // the egress was held for approval
    expect(res.pendingApprovals?.map((p) => p.toolName)).toEqual([EGRESS]);
  });

  it('an already-approved egress tool short-circuits and executes', async () => {
    executed.length = 0;
    const firewall = buildFirewallHook({ rules: [recommendedExfilRule()], approvedTools: new Set([EGRESS]) });
    await runChatToolLoop(opts({ firewall }), { callAIWithTools: scripted([READ, EGRESS]), executeTool });
    expect(executed).toEqual([READ, EGRESS]);          // approved → runs
  });

  it('a deny rule forbids the combination (never executes)', async () => {
    executed.length = 0;
    const denyRule: CapabilityRule = { id: 'd', description: '', when: { anyOf: [{ safetyTier: 'read' }], with: [{ egress: 'host-mediated' }] }, verdict: 'deny', reason: 'blocked' };
    const firewall = buildFirewallHook({ rules: [denyRule] });
    const res = await runChatToolLoop(opts({ firewall }), { callAIWithTools: scripted([READ, EGRESS]), executeTool });
    expect(executed).toEqual([READ]);
    expect(res.pendingApprovals ?? []).toEqual([]);   // deny ≠ pending
  });

  it('CGOV-4: an approved tool does NOT bypass a hard deny rule', async () => {
    executed.length = 0;
    const denyRule: CapabilityRule = { id: 'd', description: '', when: { anyOf: [{ safetyTier: 'read' }], with: [{ egress: 'host-mediated' }] }, verdict: 'deny', reason: 'blocked' };
    // EGRESS is approved (e.g. from a prior require-approval combo), but a deny verdict
    // must still be honored — approval downgrades only require-approval, never deny.
    const firewall = buildFirewallHook({ rules: [denyRule], approvedTools: new Set([EGRESS]) });
    const res = await runChatToolLoop(opts({ firewall }), { callAIWithTools: scripted([READ, EGRESS]), executeTool });
    expect(executed).toEqual([READ]);                  // egress still blocked despite approval
    expect(res.pendingApprovals ?? []).toEqual([]);    // deny ≠ pending
  });

  it('no firewall ⇒ both run (unchanged path)', async () => {
    executed.length = 0;
    await runChatToolLoop(opts({}), { callAIWithTools: scripted([READ, EGRESS]), executeTool });
    expect(executed).toEqual([READ, EGRESS]);
  });

  it('egress alone (no prior read) ⇒ runs (no risky combination)', async () => {
    executed.length = 0;
    const firewall = buildFirewallHook({ rules: [recommendedExfilRule()] });
    await runChatToolLoop(opts({ firewall }), { callAIWithTools: scripted([EGRESS]), executeTool });
    expect(executed).toEqual([EGRESS]);
  });

  it('unclassified next tool: "skip" allows (fail-open); "treat-as-risky" defers after a read', async () => {
    const MYSTERY = 'custom.mystery.tool'; // not in the classifier
    const o = (fw: ReturnType<typeof buildFirewallHook>) => opts({ firewall: fw, tools: [tool(READ), tool(MYSTERY)] });

    executed.length = 0;
    await runChatToolLoop(o(buildFirewallHook({ rules: [recommendedExfilRule()], unknownToolPolicy: 'skip' })),
      { callAIWithTools: scripted([READ, MYSTERY]), executeTool });
    expect(executed).toEqual([READ, MYSTERY]); // fail-open: unclassified passes

    executed.length = 0;
    const res = await runChatToolLoop(o(buildFirewallHook({ rules: [recommendedExfilRule()], unknownToolPolicy: 'treat-as-risky' })),
      { callAIWithTools: scripted([READ, MYSTERY]), executeTool });
    expect(executed).toEqual([READ]);                // read ran
    expect(executed).not.toContain(MYSTERY);         // unclassified treated as risky egress → deferred
    expect(res.pendingApprovals?.map((p) => p.toolName)).toEqual([MYSTERY]);
  });
});
