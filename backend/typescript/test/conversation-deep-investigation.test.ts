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
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { activateAgentCapability } from '../src/host/agentProfileService.js';
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
// ADR 0373 — the agentProfile capability store rides host_ext_kv.
initHostExtPersistence(storage);

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

  // The original ADR 0089 truth table — now pinned with `deepActivated: false`,
  // i.e. these prove the VESTIGIAL manifest path still works (ADR 0373 §2).
  it('true only for a tool-bearing agent that DECLARED investigationDepth:deep', () => {
    expect(conversationDeepInvestigationEligible(run({ credentialRef: 'managed:openwop-free' }), agent({ investigationDepth: 'deep' }), false)).toBe(true);
  });
  it('false when the agent did NOT opt in (default off)', () => {
    expect(conversationDeepInvestigationEligible(run({ credentialRef: 'managed:openwop-free' }), agent({}), false)).toBe(false);
  });
  it('TRUE for an opted-in agent with an empty manifest — the ADR 0315 baseline makes every agent tool-bearing', () => {
    expect(conversationDeepInvestigationEligible(run({ credentialRef: 'managed:openwop-free' }), agent({ investigationDepth: 'deep', toolAllowlist: [] }), false)).toBe(true);
  });
  it('still false on a provider with no tool-calling path, baseline or not', () => {
    expect(conversationDeepInvestigationEligible(run({ credentialRef: 'byok:k', provider: 'mock' }), agent({ investigationDepth: 'deep', toolAllowlist: [] }), false)).toBe(false);
  });

  // ── ADR 0373 — the host-ext capability is the PRIMARY activation source. ──
  it('TRUE when the profile capability is activated, with NO manifest field', () => {
    expect(conversationDeepInvestigationEligible(run({ credentialRef: 'managed:openwop-free' }), agent({}), true)).toBe(true);
  });
  it('FALSE when neither the capability nor the manifest field is present', () => {
    expect(conversationDeepInvestigationEligible(run({ credentialRef: 'managed:openwop-free' }), agent({}), false)).toBe(false);
  });
  it('the capability does NOT bypass tool-bearing eligibility (non-tool provider stays false)', () => {
    expect(conversationDeepInvestigationEligible(run({ credentialRef: 'byok:k', provider: 'mock' }), agent({}), true)).toBe(false);
  });
  it('honors the per-exchange model override when judging eligibility (the pre-0373 bug)', () => {
    // run.inputs says a NON-tool-calling provider; the exchange override moves
    // this turn onto a tool-calling one. Eligibility must judge the EFFECTIVE
    // provider — the same one the dispatch will hand the nested run.
    expect(
      conversationDeepInvestigationEligible(
        run({ credentialRef: 'byok:k', provider: 'mock', model: 'mock-1' }), agent({}), true,
        { provider: 'anthropic', model: 'claude-sonnet-5' },
      ),
      'an override onto a tool-calling provider must make a capable agent eligible',
    ).toBe(true);
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
    // byok + provider:mock (no native tool-calling) ⇒ the inline single-completion
    // path runs. (ADR 0315: the managed DEFAULT now always takes the tool loop —
    // the baseline makes every agent tool-bearing — so pinning the inline
    // mechanics requires a non-tool-calling provider ref.)
    const interrupt = await seedConversation(runId, { provider: 'mock', model: 'mock-1', credentialRef: 'byok:mock' });
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

/**
 * XCH-GRP-3 — the per-room deep-run budget. A deep @mention is human-ELECTED
 * (so it stays the endorsed exception to the #1831 group opt-out), but it
 * dispatches a whole tool-running run, so a mention-storm in ONE room is
 * budgeted. Over budget DEGRADES to the inline turn + an honest notice — it
 * never fails the turn (the #1829 precedent).
 */
describe('deep-investigation budget degrade (XCH-GRP-3)', () => {
  beforeAll(() => { registerAgent('test.deep-budgeted', { investigationDepth: 'deep' }); });

  it('dispatches while in budget, then DEGRADES to inline with an honest notice', async () => {
    process.env.OPENWOP_DEEP_RUN_LIMIT_PER_ROOM = '1';
    try {
      const startAgentMentionRun = vi.fn<NonNullable<ConversationHostDeps['startAgentMentionRun']>>()
        .mockResolvedValue('nested-run-budget-1');

      // ONE room, two @mentions — the conversationId is the budget's bucket.
      const interrupt = await seedConversation('r-budget-1', { credentialRef: 'managed:openwop-free' });

      // 1st @mention in this room: in budget ⇒ the nested run dispatches.
      const first = await handleConversationResolve(
        storage, interrupt,
        { operation: 'exchange', turn: { to: 'test.deep-budgeted', content: 'Investigate one.' } },
        async () => {}, { policyResolver: policyStub, startAgentMentionRun },
      );
      expect(startAgentMentionRun).toHaveBeenCalledTimes(1);
      expect(first.notice).toBeUndefined();

      // 2nd @mention in the SAME room: over budget. The turn still SUCCEEDS —
      // no throw — and no second run is dispatched.
      resetMockPrograms();
      programMock('', [{ content: 'Direct answer instead.' }]);
      const second = await handleConversationResolve(
        storage, interrupt,
        { operation: 'exchange', turn: { to: 'test.deep-budgeted', content: 'Investigate two.' } },
        async () => {}, { policyResolver: policyStub, startAgentMentionRun },
      );
      expect(startAgentMentionRun, 'over budget ⇒ no second nested run').toHaveBeenCalledTimes(1);
      expect(second.notice, 'the degrade must be surfaced, never silent').toEqual({
        code: 'deep_run_budget_exceeded', limit: 1,
      });
    } finally {
      delete process.env.OPENWOP_DEEP_RUN_LIMIT_PER_ROOM;
    }
  });

  it('a DIFFERENT room is unaffected by a room that spent its budget', async () => {
    process.env.OPENWOP_DEEP_RUN_LIMIT_PER_ROOM = '1';
    try {
      const startAgentMentionRun = vi.fn<NonNullable<ConversationHostDeps['startAgentMentionRun']>>()
        .mockResolvedValue('nested-run-budget-2');
      for (const rid of ['r-budget-room-a', 'r-budget-room-b']) {
        await handleConversationResolve(
          storage, await seedConversation(rid, { credentialRef: 'managed:openwop-free' }),
          { operation: 'exchange', turn: { to: 'test.deep-budgeted', content: 'Investigate.' } },
          async () => {}, { policyResolver: policyStub, startAgentMentionRun },
        );
      }
      expect(startAgentMentionRun, 'each room gets its own budget').toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.OPENWOP_DEEP_RUN_LIMIT_PER_ROOM;
    }
  });

  it('limit <= 0 ⇒ unlimited: the budget never degrades the deep path', async () => {
    process.env.OPENWOP_DEEP_RUN_LIMIT_PER_ROOM = '0';
    try {
      const startAgentMentionRun = vi.fn<NonNullable<ConversationHostDeps['startAgentMentionRun']>>()
        .mockResolvedValue('nested-run-unlimited');
      const interrupt = await seedConversation('r-budget-unlimited', { credentialRef: 'managed:openwop-free' });
      for (const n of [1, 2, 3]) {
        const res = await handleConversationResolve(
          storage, interrupt,
          { operation: 'exchange', turn: { to: 'test.deep-budgeted', content: `Investigate ${n}.` } },
          async () => {}, { policyResolver: policyStub, startAgentMentionRun },
        );
        expect(res.notice).toBeUndefined();
      }
      expect(startAgentMentionRun).toHaveBeenCalledTimes(3);
    } finally {
      delete process.env.OPENWOP_DEEP_RUN_LIMIT_PER_ROOM;
    }
  });
});

/**
 * ADR 0373 — ACTIVATION. The capability is what makes the deep path reachable at
 * all: before this, `investigationDepth` was dropped by the pack loader and
 * forbidden by the SPEC agent-manifest schema, so no shipped agent could opt in.
 * Activation now rides the existing `AgentProfile.capabilities` seam
 * (ARCHITECTURE.md "Agent config + capability activation").
 */
describe('ADR 0373 — deep investigation activates via the agentProfile capability', () => {
  beforeAll(() => {
    // NO manifest `investigationDepth` — activation must come from the profile
    // alone, which is the whole point of the ADR.
    registerAgent('test.capability-agent', { toolAllowlist: [] });
  });

  it('a plain agent takes the INLINE path until the capability is activated, then dispatches the nested run', async () => {
    const startAgentMentionRun = vi.fn<NonNullable<ConversationHostDeps['startAgentMentionRun']>>()
      .mockResolvedValue('nested-capability-run');

    // BEFORE activation: no profile capability ⇒ inline (no nested dispatch).
    resetMockPrograms();
    programMock('', [{ content: 'Inline reply.' }]);
    await handleConversationResolve(
      storage, await seedConversation('r-cap-before', { provider: 'mock', model: 'mock-1', credentialRef: 'byok:mock' }),
      { operation: 'exchange', turn: { to: 'test.capability-agent', content: 'Look into this.' } },
      async () => {}, { policyResolver: policyStub, startAgentMentionRun },
    );
    expect(startAgentMentionRun, 'not activated ⇒ no nested run').not.toHaveBeenCalled();

    // ACTIVATE via the real host-ext seam — keyed by the agent's own id (a pack
    // agent has no roster entry, and AgentProfile.profileId accepts an agentId).
    await activateAgentCapability(TENANT, 'test.capability-agent', 'deep-investigation', {
      roleKey: 'researcher', autonomy: { level: 'review', specLevel: 'draft-only' },
    });

    // AFTER activation: the SAME @mention now dispatches the nested run.
    const after = await handleConversationResolve(
      storage, await seedConversation('r-cap-after', { credentialRef: 'managed:openwop-free' }),
      { operation: 'exchange', turn: { to: 'test.capability-agent', content: 'Look into this.' } },
      async () => {}, { policyResolver: policyStub, startAgentMentionRun },
    );
    expect(startAgentMentionRun, 'activated ⇒ the nested run dispatches').toHaveBeenCalledTimes(1);
    expect(after.turns.at(-1)?.content).toMatchObject({ kind: 'workflow_run', runId: 'nested-capability-run' });
  });

  it('the capability is TENANT-scoped — another tenant\'s activation does not leak', async () => {
    await activateAgentCapability('t-other', 'test.tenant-scoped-agent', 'deep-investigation', {
      roleKey: 'researcher', autonomy: { level: 'review', specLevel: 'draft-only' },
    });
    registerAgent('test.tenant-scoped-agent', { toolAllowlist: [] });
    const startAgentMentionRun = vi.fn<NonNullable<ConversationHostDeps['startAgentMentionRun']>>()
      .mockResolvedValue('should-not-happen');
    resetMockPrograms();
    programMock('', [{ content: 'Inline reply.' }]);
    await handleConversationResolve(
      storage, await seedConversation('r-cap-tenant', { provider: 'mock', model: 'mock-1', credentialRef: 'byok:mock' }),
      { operation: 'exchange', turn: { to: 'test.tenant-scoped-agent', content: 'Look into this.' } },
      async () => {}, { policyResolver: policyStub, startAgentMentionRun },
    );
    expect(startAgentMentionRun, "another tenant's grant must not activate ours").not.toHaveBeenCalled();
  });

  it('the MANAGED tier hands the nested run NO provider/model — the resolver\'s "unknown" sentinel must not leak', async () => {
    // effectiveModelTarget defaults model to the string 'unknown' when run.inputs
    // has none (applyRoute.ts:77). It is truthy, so a naive spread would pass
    // `model: 'unknown'` to the nested run and break preferManaged on the managed
    // tier — the exact regression the ADR 0373 code-review caught.
    registerAgent('test.managed-agent', { toolAllowlist: [] });
    await activateAgentCapability(TENANT, 'test.managed-agent', 'deep-investigation', {
      roleKey: 'researcher', autonomy: { level: 'review', specLevel: 'draft-only' },
    });
    const startAgentMentionRun = vi.fn<NonNullable<ConversationHostDeps['startAgentMentionRun']>>()
      .mockResolvedValue('nested-managed-run');
    await handleConversationResolve(
      storage, await seedConversation('r-cap-managed', { credentialRef: 'managed:openwop-free' }),
      { operation: 'exchange', turn: { to: 'test.managed-agent', content: 'Investigate.' } },
      async () => {}, { policyResolver: policyStub, startAgentMentionRun },
    );
    expect(startAgentMentionRun).toHaveBeenCalledTimes(1);
    const passed = startAgentMentionRun.mock.calls[0]![0];
    expect(passed.model, "the 'unknown' sentinel must never reach the nested run").toBeUndefined();
    expect(passed.provider, 'managed tier has no provider ⇒ preferManaged must stay true').toBeUndefined();
  });

  it('the dispatch hands the nested run the OVERRIDE-resolved model, not run.inputs raw (the pre-0373 bug)', async () => {
    registerAgent('test.override-agent', { toolAllowlist: [] });
    await activateAgentCapability(TENANT, 'test.override-agent', 'deep-investigation', {
      roleKey: 'researcher', autonomy: { level: 'review', specLevel: 'draft-only' },
    });
    const startAgentMentionRun = vi.fn<NonNullable<ConversationHostDeps['startAgentMentionRun']>>()
      .mockResolvedValue('nested-override-run');

    // run.inputs pins one BYOK model; the per-exchange override picks another.
    // `agentRunnerNode.resolveParams` takes provider/model VERBATIM, so what the
    // exchange hands over IS the nested run's model — it must be the override's.
    await handleConversationResolve(
      storage, await seedConversation('r-cap-override', { provider: 'anthropic', model: 'claude-old', credentialRef: 'byok:anthropic' }),
      { operation: 'exchange', turn: { to: 'test.override-agent', content: 'Investigate.' }, model: 'claude-sonnet-5', provider: 'anthropic' },
      async () => {}, { policyResolver: policyStub, startAgentMentionRun },
    );
    expect(startAgentMentionRun).toHaveBeenCalledTimes(1);
    expect(startAgentMentionRun.mock.calls[0]![0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });
  });
});
