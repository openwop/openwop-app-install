/**
 * ADR 0089 Phase 4 (Option B) — dispatch a deep-investigation @mentioned agent
 * as a nested agentic RUN (a `workflow_run` chat bubble) instead of the inline
 * turn loop.
 *
 * Proves the three load-bearing invariants of the backend MVP:
 *   (a) an OPTED-IN tool agent (`investigationDepth: 'deep'`) @mention dispatches
 *       the nested run via the injected `startAgentMentionRun` — NOT the inline
 *       single-completion path (the recorded agent turn is a `workflow_run` ref);
 *   (b) a NON-opted-in tool agent still takes the inline path UNCHANGED (no nested
 *       run; a normal text agent turn);
 *   (c) the agent-runner node enters agentic execution through the SINGLE GATED
 *       owner (`runAgentDispatchLive`) with the host tool deps — no second path —
 *       and emits the loop's RFC 0064 `agent.*` events onto the run.
 */

import { describe, expect, it, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import {
  handleConversationResolve,
  conversationDeepInvestigationEligible,
  type ConversationHostDeps,
} from '../src/host/conversationExchange.js';
import agentRunnerNode from '../src/host/agentRunnerNode.js';
import { agentMentionConfigurable } from '../src/host/agentMentionWorkflows.js';
import * as agentDispatch from '../src/host/agentDispatch.js';
import { programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord, InterruptRecord } from '../src/types.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';
import type { NodeContext } from '../src/executor/types.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-deepinv-')) });

const TENANT = 't-deepinv';
const policyStub = (() => undefined) as unknown as ProviderPolicyResolver;

function registerAgent(id: string, extra: Partial<ResolvedAgentManifest>): void {
  getAgentRegistry().register({
    agentId: id,
    persona: 'Researcher',
    modelClass: 'reasoning',
    systemPrompt: 'You research.',
    packName: 'core.openwop.test',
    packVersion: '0',
    toolAllowlist: ['openwop:ai.research.web'],
    ...extra,
  });
}

/** Seed an opened conversation run + its suspended gate interrupt. */
async function seedConversation(runId: string, inputs: Record<string, unknown>): Promise<InterruptRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId, workflowId: 'openwop-app.conversation', tenantId: TENANT,
    status: 'waiting-input', inputs, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  } as RunRecord;
  await storage.insertRun(run);
  const conversationId = `${runId}:gate:0`;
  await storage.appendEvent({
    eventId: `${runId}-open`, runId, type: 'conversation.opened', nodeId: 'gate',
    payload: { conversationId, initialTurn: { conversationId, turnIndex: 0, role: 'system', from: 'system', content: 'Started.', ts: Date.now(), messageId: `${conversationId}:0` } },
    timestamp: now,
  });
  const interrupt: InterruptRecord = {
    interruptId: `${runId}:gate`, runId, nodeId: 'gate', kind: 'conversation',
    data: { conversationId }, createdAt: now,
  } as InterruptRecord;
  return interrupt;
}

async function agentTurnOf(runId: string): Promise<{ role?: string; content?: unknown } | undefined> {
  const events = await storage.listEvents(runId);
  const exchanged = events.filter((e) => e.type === 'conversation.exchanged');
  const agentEv = exchanged.find((e) => ((e.payload as { turn?: { role?: string } })?.turn?.role) === 'agent');
  return (agentEv?.payload as { turn?: { role?: string; content?: unknown } })?.turn;
}

describe('conversationDeepInvestigationEligible (the opt-in gate)', () => {
  const run = (inputs: Record<string, unknown>): RunRecord => ({ runId: 'r', tenantId: TENANT, inputs } as unknown as RunRecord);
  const agent = (p: Partial<ResolvedAgentManifest>): ResolvedAgentManifest =>
    ({ agentId: 'a', persona: 'P', toolAllowlist: ['openwop:ai.research.web'], ...p } as unknown as ResolvedAgentManifest);

  it('true only for a tool-bearing agent that DECLARED investigationDepth:deep', () => {
    expect(conversationDeepInvestigationEligible(run({ credentialRef: 'managed:openwop-free' }), agent({ investigationDepth: 'deep' }))).toBe(true);
  });
  it('false when the agent did NOT opt in (default off)', () => {
    expect(conversationDeepInvestigationEligible(run({ credentialRef: 'managed:openwop-free' }), agent({}))).toBe(false);
  });
  it('false when opted in but the agent is not tool-bearing', () => {
    expect(conversationDeepInvestigationEligible(run({ credentialRef: 'managed:openwop-free' }), agent({ investigationDepth: 'deep', toolAllowlist: [] }))).toBe(false);
  });
});

describe('handleConversationResolve — Option B dispatch routing', () => {
  beforeAll(() => {
    registerAgent('test.deep-researcher', { investigationDepth: 'deep' });
    // A non-opted-in agent (no `investigationDepth`). Pure-persona + provider:mock
    // so the inline single-completion path runs deterministically (no key needed).
    registerAgent('test.inline-researcher', { toolAllowlist: [] });
  });

  it('(a) an opted-in tool agent @mention dispatches the NESTED run (not inline)', async () => {
    const runId = 'r-deep-1';
    const interrupt = await seedConversation(runId, { credentialRef: 'managed:openwop-free' });
    const startAgentMentionRun = vi.fn<NonNullable<ConversationHostDeps['startAgentMentionRun']>>()
      .mockResolvedValue('nested-run-abc');

    const result = await handleConversationResolve(
      storage, interrupt,
      { operation: 'exchange', turn: { to: 'test.deep-researcher', content: 'Investigate the market.' } },
      async () => {},
      { policyResolver: policyStub, startAgentMentionRun },
    );

    // The nested run was dispatched via the gated run-starter, with the user task.
    expect(startAgentMentionRun).toHaveBeenCalledTimes(1);
    expect(startAgentMentionRun.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT, agentId: 'test.deep-researcher', task: 'Investigate the market.',
    });
    // The recorded agent turn is a workflow_run reference (the chat embeds the run
    // bubble), NOT an inline text completion.
    const turn = await agentTurnOf(runId);
    expect(turn?.content).toEqual({ kind: 'workflow_run', runId: 'nested-run-abc', agentId: 'test.deep-researcher' });
    expect(result.turns.map((t) => t.role)).toEqual(['system', 'user', 'agent']);
  });

  it('(b) a non-opted-in tool agent still uses the INLINE path unchanged', async () => {
    const runId = 'r-inline-1';
    // provider:mock ⇒ the inline single-completion path runs (no tool loop, no key).
    const interrupt = await seedConversation(runId, { provider: 'mock', model: 'mock-1' });
    resetMockPrograms();
    programMock('', [{ content: 'Inline reply.' }]); // the conversation mock path keys by nodeId ''
    const startAgentMentionRun = vi.fn<NonNullable<ConversationHostDeps['startAgentMentionRun']>>()
      .mockResolvedValue('should-not-happen');

    try {
      await handleConversationResolve(
        storage, interrupt,
        { operation: 'exchange', turn: { to: 'test.inline-researcher', content: 'Just answer inline.' } },
        async () => {},
        { policyResolver: policyStub, startAgentMentionRun },
      );

      // No nested run — the inline path produced a plain text agent turn.
      expect(startAgentMentionRun).not.toHaveBeenCalled();
      const turn = await agentTurnOf(runId);
      expect(turn?.content).toBe('Inline reply.'); // a string completion, not a workflow_run ref
    } finally {
      resetMockPrograms();
    }
  });
});

describe('agentRunnerNode — enters the GATED dispatch owner (no second path)', () => {
  beforeAll(() => {
    registerAgent('test.runner-agent', {});
  });

  it('(c) calls runAgentDispatchLive with the host tool deps + emits its agent.* events', async () => {
    const spy = vi.spyOn(agentDispatch, 'runAgentDispatchLive').mockResolvedValue({
      agentId: 'test.runner-agent', persona: 'Researcher', modelClass: 'reasoning',
      status: 'completed', toolSurface: ['openwop:ai.research.web'], confidence: 1, threshold: 0.7,
      events: [
        { type: 'agent.reasoned', agentId: 'test.runner-agent', summary: 'thinking' },
        { type: 'agent.toolReturned', agentId: 'test.runner-agent', toolName: 'openwop:ai.research.web', status: 'ok' },
      ],
      result: { content: 'Final research report.' }, live: true, provider: 'anthropic', model: 'claude-x',
    });
    try {
      const emitted: string[] = [];
      const callAIWithTools = vi.fn();
      const callAI = vi.fn();
      const ctx: NodeContext = {
        runId: 'nested-run-abc', nodeId: 'run', tenantId: TENANT,
        inputs: { agentId: 'test.runner-agent', task: 'go deep', provider: 'anthropic', model: 'claude-x', credentialRef: 'byok:k' },
        config: {}, configurable: {}, attempt: 1, secrets: {},
        callAI, callAIWithTools,
        emit: async (type: string) => { emitted.push(type); return { eventId: '', sequence: 0 }; },
      } as unknown as NodeContext;

      const outcome = await agentRunnerNode.execute(ctx);

      // The gated owner was called exactly once, with the run's provider adapter
      // (callAI/callAIWithTools) + a resolveTool/executeTool pair + the tenant.
      expect(spy).toHaveBeenCalledTimes(1);
      const [req, deps] = spy.mock.calls[0]!;
      expect(req.agentId).toBe('test.runner-agent');
      expect(req.task).toBe('go deep');
      expect(deps.callAI).toBe(callAI);
      expect(deps.callAIWithTools).toBe(callAIWithTools);
      expect(typeof deps.resolveTool).toBe('function');
      expect(typeof deps.executeTool).toBe('function');
      expect(deps.tenantId).toBe(TENANT);
      expect(deps.modelOptions).toMatchObject({ provider: 'anthropic', model: 'claude-x' });
      expect(deps.credentialRef).toBe('byok:k');

      // The loop's RFC 0064 agent.* events were emitted onto THIS run.
      expect(emitted).toContain('agent.reasoned');
      expect(emitted).toContain('agent.toolReturned');

      // The final answer is the node's success output.
      expect(outcome.status).toBe('success');
      expect((outcome as { outputs: { text: string } }).outputs.text).toBe('Final research report.');
    } finally {
      spy.mockRestore();
    }
  });

  it('fails closed when the run has no provider adapter wired', async () => {
    const ctx: NodeContext = {
      runId: 'r', nodeId: 'run', tenantId: TENANT,
      inputs: { agentId: 'test.runner-agent', task: 'x' },
      config: {}, configurable: {}, attempt: 1, secrets: {},
      emit: async () => ({ eventId: '', sequence: 0 }),
    } as unknown as NodeContext;
    const outcome = await agentRunnerNode.execute(ctx);
    expect(outcome.status).toBe('failure');
  });

  // BYOK fix (review): a non-managed credentialRef must be registered in the nested
  // run's `configurable.credentialRefs` so prepareRunSecrets resolves it; a managed
  // ref needs no secret. Without this, BYOK deep-investigation runs 401 byok_required.
  it('agentMentionConfigurable registers a BYOK ref, omits managed + absent', () => {
    expect(agentMentionConfigurable('byok:user:anthropic')).toEqual({ credentialRefs: ['byok:user:anthropic'] });
    expect(agentMentionConfigurable('managed:openwop-free')).toEqual({});
    expect(agentMentionConfigurable(undefined)).toEqual({});
  });
});
