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
  approvedToolSets,
  eraseConversationToolApprovalsSubject,
  deleteToolApprovalsForConversation,
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
    // ADR 0834 D2 (FW2-CD-5) — a scope ask is the owner's own, user-level (`baseline`):
    // approving it must not satisfy a later workspace/platform ask on the same tool.
    expect(res.pendingApprovals).toEqual([{ toolName: 'email.send', callId: '1', input: { to: 'x' }, origin: 'baseline' }]);
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

describe('approval ledger — ADR 0834 D2/D6', () => {
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

  it('an approval answers an ask: no pending row ⇒ refused (nothing approvable in advance)', async () => {
    expect(await resolveToolApproval('t', 'pre', 'code.run', 'approved', 'owner')).toEqual({ ok: false, reason: 'no_pending_approval' });
    expect(await listToolApprovals('t', 'pre')).toHaveLength(0);
  });

  it('stores the held arguments (scrubbed) while pending and clears them on decision', async () => {
    await recordToolApprovalRequested('t', 'args', 'http.fetch', { origin: 'baseline', input: { url: 'https://x.example', token: 'sk-ant-api03-SECRETSECRETSECRETSECRET' } });
    const [pending] = await listToolApprovals('t', 'args');
    expect(pending?.requestedInput).toContain('https://x.example');
    expect(pending?.requestedInput).not.toContain('SECRETSECRETSECRET');
    const out = await resolveToolApproval('t', 'args', 'http.fetch', 'approved', 'owner', pending!.requestedAt);
    expect(out.ok).toBe(true);
    const [decided] = await listToolApprovals('t', 'args');
    expect(decided?.requestedInput).toBeUndefined();
  });

  it('compare-and-set: approving a row that moved since it was shown is refused', async () => {
    await recordToolApprovalRequested('t', 'cas', 'http.fetch', { input: { url: 'a' } });
    const [shown] = await listToolApprovals('t', 'cas');
    await new Promise((r) => setTimeout(r, 5));
    await recordToolApprovalRequested('t', 'cas', 'http.fetch', { input: { url: 'b' } }); // the agent re-asked
    expect(await resolveToolApproval('t', 'cas', 'http.fetch', 'approved', 'owner', shown!.requestedAt)).toEqual({ ok: false, reason: 'approval_changed' });
  });

  it('a policy ask RE-OPENS a tool approved only for the baseline; a baseline ask does not', async () => {
    await recordToolApprovalRequested('t', 'esc', 'x.send', { origin: 'baseline' });
    await resolveToolApproval('t', 'esc', 'x.send', 'approved', 'owner');
    await recordToolApprovalRequested('t', 'esc', 'x.send', { origin: 'baseline' });
    expect((await listToolApprovals('t', 'esc'))[0]).toMatchObject({ status: 'approved', origin: 'baseline' });
    await recordToolApprovalRequested('t', 'esc', 'x.send', { origin: 'policy' });
    expect((await listToolApprovals('t', 'esc'))[0]).toMatchObject({ status: 'pending', origin: 'policy' });
  });

  it('approvedToolSets: policy rows satisfy any ask; baseline and legacy rows only the baseline', () => {
    const rows = [
      { tenantId: 't', conversationId: 'c', toolName: 'p', status: 'approved' as const, requestedAt: '', origin: 'policy' as const },
      { tenantId: 't', conversationId: 'c', toolName: 'b', status: 'approved' as const, requestedAt: '', origin: 'baseline' as const },
      { tenantId: 't', conversationId: 'c', toolName: 'legacy', status: 'approved' as const, requestedAt: '' },
      { tenantId: 't', conversationId: 'c', toolName: 'd', status: 'denied' as const, requestedAt: '', origin: 'policy' as const },
    ];
    const sets = approvedToolSets(rows);
    expect([...sets.approvedTools]).toEqual(['p']);
    expect([...sets.approvedBaselineTools].sort()).toEqual(['b', 'legacy']);
  });

  it('the DSAR eraser redacts the approver and keeps the decision', async () => {
    await recordToolApprovalRequested('t-er', 'c', 'x.send');
    await resolveToolApproval('t-er', 'c', 'x.send', 'approved', 'alice');
    await eraseConversationToolApprovalsSubject('t-er', 'alice');
    const [row] = await listToolApprovals('t-er', 'c');
    expect(row?.status).toBe('approved');
    expect(row?.resolvedBy).not.toBe('alice');
  });

  it('a deleted conversation takes its approvals with it', async () => {
    await recordToolApprovalRequested('t-del', 'gone', 'x.send', { input: { a: 1 } });
    await deleteToolApprovalsForConversation('t-del', 'gone');
    expect(await listToolApprovals('t-del', 'gone')).toHaveLength(0);
  });
});
