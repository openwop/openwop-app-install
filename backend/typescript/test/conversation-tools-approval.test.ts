/**
 * ADR 0132 Phase 3 — per-conversation tool approval: the loop defers a
 * require-approval call (does not execute it), the pure decision fold, and the
 * durable ledger.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { runChatToolLoop, type CompiledTool, type ChatToolLoopOpts } from '../src/host/agentDispatch.js';
import { applyApprovalDecisions } from '../src/features/conversation-tools/scopeResolver.js';
import {
  recordToolApprovalRequested,
  resolveToolApproval,
  listToolApprovals,
} from '../src/features/conversation-tools/approvalLedger.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

function tool(name: string): CompiledTool {
  return { def: { name, description: name, inputSchema: { type: 'object', additionalProperties: true } }, validate: () => ({ ok: true }) };
}
const TOOLS = [tool('kb.search'), tool('email.send')];

const executed: string[] = [];
const executeTool = async (c: { name: string; input: Record<string, unknown> }) => { executed.push(c.name); return { content: `ran ${c.name}` }; };

function scripted(call: string) {
  let n = 0;
  return async (_r: AiToolCallRequest): Promise<AiToolCallResult> => {
    n += 1;
    return n === 1 ? { content: '', toolCalls: [{ id: '1', name: call, input: { to: 'x' } }] } : { content: 'done', toolCalls: [] };
  };
}
function opts(extra: Partial<ChatToolLoopOpts>): ChatToolLoopOpts {
  return { provider: 'p', model: 'm', credentialRef: 'byok:k', systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, agentId: 'a', persona: 'P', maxRounds: 3, ...extra };
}

describe('runChatToolLoop require-approval (ADR 0132 P3)', () => {
  it('DEFERS a require-approval call — does not execute it, returns it as pending', async () => {
    executed.length = 0;
    const res = await runChatToolLoop(
      opts({ capabilityScope: { enabled: ['kb.search', 'email.send'], requireApproval: ['email.send'] } }),
      { callAIWithTools: scripted('email.send'), executeTool },
    );
    expect(executed).not.toContain('email.send');        // NOT executed
    expect(res.pendingApprovals).toEqual([{ toolName: 'email.send', callId: '1', input: { to: 'x' } }]);
  });

  it('an enabled, non-approval call still executes (no pending)', async () => {
    executed.length = 0;
    const res = await runChatToolLoop(
      opts({ capabilityScope: { enabled: ['kb.search', 'email.send'], requireApproval: ['email.send'] } }),
      { callAIWithTools: scripted('kb.search'), executeTool },
    );
    expect(executed).toEqual(['kb.search']);
    expect(res.pendingApprovals).toBeUndefined();
  });
});

describe('applyApprovalDecisions (pure fold)', () => {
  const eff = { enabled: ['kb.search', 'email.send'], requireApproval: ['email.send'] };
  it('approved ⇒ drops out of requireApproval (executes on re-attempt)', () => {
    expect(applyApprovalDecisions(eff, [{ toolName: 'email.send', status: 'approved' }]))
      .toEqual({ enabled: ['kb.search', 'email.send'], requireApproval: [] });
  });
  it('denied ⇒ drops out of enabled (forbidden)', () => {
    expect(applyApprovalDecisions(eff, [{ toolName: 'email.send', status: 'denied' }]))
      .toEqual({ enabled: ['kb.search'], requireApproval: [] });
  });
  it('pending ⇒ unchanged (still gated)', () => {
    expect(applyApprovalDecisions(eff, [{ toolName: 'email.send', status: 'pending' }])).toEqual(eff);
  });
});

describe('approval ledger', () => {
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

  it('records pending, resolves, and lists — idempotent + decision-preserving', async () => {
    await recordToolApprovalRequested('t', 'conv1', 'email.send');
    let recs = await listToolApprovals('t', 'conv1');
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ toolName: 'email.send', status: 'pending' });

    // re-request is a no-op (does not reset)
    await resolveToolApproval('t', 'conv1', 'email.send', 'approved', 'user:1');
    await recordToolApprovalRequested('t', 'conv1', 'email.send'); // must NOT reset to pending
    recs = await listToolApprovals('t', 'conv1');
    expect(recs[0]).toMatchObject({ status: 'approved', resolvedBy: 'user:1' });

    // tenant/conversation scoping
    expect(await listToolApprovals('t', 'conv2')).toHaveLength(0);
  });
});
