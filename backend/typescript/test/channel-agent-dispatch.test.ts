/**
 * ADR 0154 Phase 4 — channel agent-turn targeting + workflow registration.
 */
import { describe, it, expect } from 'vitest';
import { selectChannelTurnTargets } from '../src/features/channels/channelAgentDispatch.js';
import { CHANNEL_TURN_WORKFLOW_ID, seedChannelTurnWorkflow } from '../src/features/channels/channelTurnWorkflow.js';

describe('selectChannelTurnTargets', () => {
  it('returns [] with no agent members', () => {
    expect(selectChannelTurnTargets([], 'hello @anyone')).toEqual([]);
  });
  it('auto-targets the sole agent member when there is no @mention', () => {
    expect(selectChannelTurnTargets(['helper'], 'what is the status?')).toEqual(['helper']);
  });
  it('targets an explicitly @mentioned agent member', () => {
    expect(selectChannelTurnTargets(['helper', 'analyst'], 'hey @analyst look')).toEqual(['analyst']);
  });
  it('targets nobody for an unmatched @mention among multiple UNSTAMPED agents (derived mention)', () => {
    // Two unstamped agents → each derives 'mention' (not sole) → no auto-reply.
    expect(selectChannelTurnTargets(['helper', 'analyst'], 'hey @nobody')).toEqual([]);
  });

  // ADR 0202 D1 — effective response policy (derived read-only when unstamped).
  it('an effective-all agent replies to an unmentioned post; a mention agent does not', () => {
    const agents = [
      { agentId: 'greeter', responsePolicy: 'all' as const },
      { agentId: 'analyst', responsePolicy: 'mention' as const },
    ];
    expect(selectChannelTurnTargets(agents, 'good morning everyone')).toEqual(['greeter']);
  });
  it('an unstamped SOLE agent derives all (the pre-0200 rule, zero writes)', () => {
    expect(selectChannelTurnTargets([{ agentId: 'solo' }], 'status?')).toEqual(['solo']);
  });
  it('multiple all-policy agents all reply to an unmentioned post', () => {
    const agents = [
      { agentId: 'a', responsePolicy: 'all' as const },
      { agentId: 'b', responsePolicy: 'all' as const },
    ];
    expect(selectChannelTurnTargets(agents, 'hi').sort()).toEqual(['a', 'b']);
  });
  it('an explicit @mention overrides policy (a mention-policy agent still replies when named)', () => {
    const agents = [
      { agentId: 'a', mentionSlug: 'analyst', responsePolicy: 'mention' as const },
      { agentId: 'b', responsePolicy: 'all' as const },
    ];
    expect(selectChannelTurnTargets(agents, '@analyst look')).toEqual(['a']);
  });
  it('matches a @mention case-insensitively', () => {
    expect(selectChannelTurnTargets(['Helper'], 'ping @helper')).toEqual(['Helper']);
  });
  it('can target multiple mentioned agents', () => {
    expect(selectChannelTurnTargets(['a', 'b', 'c'], '@a and @c please').sort()).toEqual(['a', 'c']);
  });

  // ADR 0192 D1 — the persisted mention slug is what the composer autocomplete
  // inserts; matching it is the fix for the slug/agentId mismatch (a UI mention
  // silently targeting nobody in a multi-agent channel).
  it('targets an agent by its persisted mention slug', () => {
    const agents = [
      { agentId: 'core.openwop.agents.code-reviewer.default', mentionSlug: 'code-reviewer' },
      { agentId: 'core.openwop.agents.analyst.default', mentionSlug: 'analyst' },
    ];
    expect(selectChannelTurnTargets(agents, 'hey @code-reviewer look at this'))
      .toEqual(['core.openwop.agents.code-reviewer.default']);
  });
  it('still matches the raw agentId (scripts / legacy members without a slug)', () => {
    const agents = [
      { agentId: 'core.openwop.agents.code-reviewer.default', mentionSlug: 'code-reviewer' },
      { agentId: 'legacy.agent' },
    ];
    expect(selectChannelTurnTargets(agents, 'ping @legacy.agent')).toEqual(['legacy.agent']);
    expect(selectChannelTurnTargets(agents, 'ping @core.openwop.agents.code-reviewer.default'))
      .toEqual(['core.openwop.agents.code-reviewer.default']);
  });
  // ADR 0192 D5 / code-review finding 1 — an attachment-only envelope post
  // extracts to empty text; the sole-agent implicit fallback must NOT fire a
  // paid agent run with an empty task.
  it('targets nobody on empty/whitespace text, even with a sole agent member', () => {
    expect(selectChannelTurnTargets(['helper'], '')).toEqual([]);
    expect(selectChannelTurnTargets(['helper'], '   \n ')).toEqual([]);
    expect(selectChannelTurnTargets([{ agentId: 'helper', mentionSlug: 'helper' }], '')).toEqual([]);
  });
  it('matches slugs case-insensitively and dedupes same-slug agents by exact token', () => {
    const agents = [
      { agentId: 'a1', mentionSlug: 'code-reviewer' },
      { agentId: 'a2', mentionSlug: 'code-reviewer-2' },
    ];
    expect(selectChannelTurnTargets(agents, '@Code-Reviewer please')).toEqual(['a1']);
    expect(selectChannelTurnTargets(agents, '@code-reviewer-2 please')).toEqual(['a2']);
  });
});

describe('channel turn workflow registration', () => {
  it('seeds openwop-app.channel.turn idempotently, CHAIN-BACKED, with the dispatch wiring intact', async () => {
    // ADR 0703 — the graph moved from an in-tree `registerWorkflow(DEF)` to a chain
    // pack registered chain-backed under the SAME workflowId, so the READ moves to
    // `getChainBackedWorkflow` (chain-backed defs live in that module's own registry,
    // `host/index.ts` catalog source A). The idempotence assertion is unchanged, and
    // the wiring assertions below are NEW: the old test proved only that SOMETHING was
    // registered, which would have stayed green if the migration had produced a
    // definition the dispatch could not drive.
    const { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } =
      await import('../src/host/workflowChainPackLoader.js');
    const { getChainBackedWorkflow } = await import('../src/host/chainBackedWorkflows.js');
    _resetChainRegistryForTest();
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });

    seedChannelTurnWorkflow();
    seedChannelTurnWorkflow(); // idempotent
    const def = getChainBackedWorkflow(CHANNEL_TURN_WORKFLOW_ID);
    expect(def, 'registered under the original workflowId').toBeTruthy();

    // The dispatch (`channelAgentDispatch.ts`) supplies agentId/task/conversationId/
    // credentialRef through the run's `configurable`; the node MUST read them as run
    // variables under their BARE names or the turn is dead on arrival.
    expect(def!.nodes).toHaveLength(1);
    expect(def!.nodes[0]!.typeId).toBe('local.openwop-app.agent-runner');
    for (const port of ['agentId', 'task', 'conversationId', 'credentialRef']) {
      expect(def!.nodes[0]!.inputs?.[port], `${port} is bound to its run variable`)
        .toEqual({ type: 'variable', variableName: port });
    }
    expect((def!.variables ?? []).map((v) => v.name))
      .toEqual(expect.arrayContaining(['agentId', 'task', 'credentialRef', 'conversationId']));
  });
});
