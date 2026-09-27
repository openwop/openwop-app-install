/**
 * ADR 0313 / 0125 regression — the agent-runner node MUST resolve its params from
 * `run.configurable`, not only `run.inputs`.
 *
 * The autonomous dispatchers (ADR 0313 heartbeat bare-card fallback, ADR 0125
 * scheduled-chat tick, ADR 0309 schedule-followup) freeze
 * {agentId, task, credentialRef, conversationId} onto `run.configurable`, while
 * `startWorkflowRun` → `seedRunVariables` seeds the variable bag ONLY from
 * `run.inputs`. So before the `configurable` fallback in `resolveParams`, the
 * node's `{type:'variable'}` inputs resolved to undefined and it failed
 * "requires an agentId" — the entire autonomous turn was dead on arrival. The
 * @mention path (routes/interrupts.ts) passes them as `inputs` (which still
 * wins). The prior tests missed this because they stubbed the workflow catalog
 * and never ran the real executor.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import agentRunnerNode, { resolveParams } from '../src/host/agentRunnerNode.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import { effectiveToolAllowlist } from '../src/host/agentToolAllowlistService.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import type { AiCallRequest, AiCallResult, NodeContext } from '../src/executor/types.js';

// Typed-partial cast (test-only): resolveParams reads only inputs/config/configurable.
const ctx = (over: Partial<NodeContext>): NodeContext =>
  ({ inputs: {}, configurable: {}, ...over } as unknown as NodeContext);

describe('agent-runner resolveParams — precedence inputs > config > configurable', () => {
  it('resolves the full autonomous-dispatch shape from configurable when inputs are empty', () => {
    expect(
      resolveParams(ctx({ inputs: {}, configurable: { agentId: 'iris', task: 'daily digest', credentialRef: 'managed:openwop-free', conversationId: 'conv-1' } })),
    ).toEqual({ agentId: 'iris', task: 'daily digest', credentialRef: 'managed:openwop-free', conversationId: 'conv-1' });
  });

  it('inputs win over configurable (the @mention path is unchanged)', () => {
    const p = resolveParams(ctx({ inputs: { agentId: 'from-inputs' }, configurable: { agentId: 'from-configurable', task: 'from-configurable' } }));
    expect(p.agentId).toBe('from-inputs'); // inputs precedence
    expect(p.task).toBe('from-configurable'); // falls through to configurable
  });

  it('config wins over configurable but loses to inputs', () => {
    expect(resolveParams(ctx({ inputs: {}, config: { agentId: 'from-config' }, configurable: { agentId: 'from-configurable' } })).agentId).toBe('from-config');
    expect(resolveParams(ctx({ inputs: { agentId: 'from-inputs' }, config: { agentId: 'from-config' }, configurable: {} })).agentId).toBe('from-inputs');
  });

  it('still empty (→ node fails validation) when no source carries an agentId', () => {
    expect(resolveParams(ctx({ inputs: {}, configurable: { task: 'x' } })).agentId).toBe('');
  });

  // ADR 0458 P2 — the confinement lever + the additive structured output.
  it('parses `offerTools` (even []) and leaves it undefined when absent', () => {
    expect(resolveParams(ctx({ config: { offerTools: [] } })).offerTools).toEqual([]);
    expect(resolveParams(ctx({ inputs: { offerTools: ['openwop:kb.search', 42, 'x'] } })).offerTools).toEqual(['openwop:kb.search', 'x']);
    expect(resolveParams(ctx({ inputs: {} })).offerTools).toBeUndefined();
    // inputs win over config for offerTools too.
    expect(resolveParams(ctx({ inputs: { offerTools: ['a'] }, config: { offerTools: [] } })).offerTools).toEqual(['a']);
  });
});

describe('agent-runner node — ADR 0458 P2 sim confinement + structured result', () => {
  const registry = getAgentRegistry();

  beforeAll(async () => {
    initHostExtPersistence(await openStorage('memory://'));
  });
  beforeEach(() => {
    registry._resetForTest();
    vi.restoreAllMocks();
  });

  /** A sim persona shape: EMPTY manifest allowlist (like the real
   *  feature.kicktodo.agents.sim-*), a structured verdict return schema. */
  function registerSim(): void {
    const agent: ResolvedAgentManifest = {
      agentId: 'test.sim-newcomer',
      persona: 'Sim: Newcomer',
      modelClass: 'research',
      systemPrompt: 'You are a first-time participant.',
      packName: 'test',
      packVersion: '0',
      toolAllowlist: [], // read-only sim — no manifest tools
      handoff: {
        returnSchema: { type: 'object', required: ['sim', 'verdict'], properties: {} },
        validateReturn: (v) =>
          v && typeof v === 'object' && typeof (v as { verdict?: unknown }).verdict === 'string'
            ? { ok: true }
            : { ok: false, errors: 'missing verdict' },
      },
    };
    registry.register(agent);
  }

  const nodeCtx = (over: Record<string, unknown>): NodeContext =>
    ({
      tenantId: 'tenant-sim',
      runId: 'run-sim-1',
      inputs: {},
      config: {},
      configurable: {},
      emit: async () => {},
      ...over,
    } as unknown as NodeContext);

  it('the ADR 0315 baseline is a real hazard for an empty-allowlist sim — the union includes WRITE/EGRESS tools', () => {
    // WHY confinement matters: with no override, a sim's effective allowlist is
    // its ([]) manifest UNIONED with the default-on baseline (documents.draft,
    // email.draft, ai.research.web egress, …). Offering `[]` is what defeats it.
    const effective = effectiveToolAllowlist([], undefined);
    expect(effective).toContain('openwop:documents.draft');
    expect(effective).toContain('openwop:ai.research.web');
  });

  it('offerTools:[] confines the sim to a ZERO-tool surface and surfaces the typed `result`', async () => {
    registerSim();
    // The raw sim-verdict schema shape the persona returns (no `sim` — the agent
    // knows who it is; sim-collect attaches the persona downstream).
    const verdict = { verdict: 'flag', personaSummary: 'day 2 is tight', findings: [{ severity: 'flag', text: 'day-2-load', day: 2 }] };
    const callAI = vi.fn<(req: AiCallRequest) => Promise<AiCallResult>>(async () => ({ data: verdict }));
    const callAIWithTools = vi.fn(async () => { throw new Error('a confined sim must not enter the tool loop'); });

    const out = await agentRunnerNode.execute(nodeCtx({
      config: { offerTools: [] },
      inputs: { agentId: 'test.sim-newcomer', task: 'walk the plan', credentialRef: 'managed:openwop-free' },
      callAI,
      callAIWithTools,
    }));

    expect(out.status).toBe('success');
    const outputs = (out as { outputs: Record<string, unknown> }).outputs;
    // Confinement: ZERO tools offered (no ADR 0315 baseline union reached the model).
    expect(outputs.toolSurface).toEqual([]);
    // The single-completion path ran (no tool loop) — proof the surface was empty.
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(callAIWithTools).not.toHaveBeenCalled();
    // ADDITIVE structured output: the typed verdict is surfaced (not only `text`).
    expect(outputs.result).toEqual(verdict);
    expect(outputs.text).toBe(JSON.stringify(verdict));
  });

  it('ADR 0277 — a ROSTER id dispatches the agent it wraps (the KickBot coach-turn defect, kicktodo.com 2026-09-16)', async () => {
    // A roster persona over a registered agent: the shape KickBot's reminder coach
    // turn hands this node (`configurable.agentId = host:kickbot`). Before the fix
    // the node resolved the identity and then dispatched the RAW roster id, so the
    // registry missed and the run failed `agent_not_found`.
    registry.register({
      agentId: 'test.roster-wrapped',
      persona: 'Roster Wrapped',
      modelClass: 'chat',
      systemPrompt: 'You coach.',
      packName: 'test',
      packVersion: '0',
      toolAllowlist: [],
    } as ResolvedAgentManifest);
    const entry = await createRosterEntry({
      tenantId: 'tenant-roster',
      persona: `Roster Wrapped ${Date.now()}`,
      agentRef: { agentId: 'test.roster-wrapped', version: '0' },
    });
    expect(entry.rosterId.startsWith('host:')).toBe(true);
    const callAI = vi.fn<(req: AiCallRequest) => Promise<AiCallResult>>(async () => ({ data: 'Nice work on day one.' }));
    const callAIWithTools = vi.fn(async () => { throw new Error('no tools were offered'); });

    const out = await agentRunnerNode.execute(nodeCtx({
      tenantId: 'tenant-roster',
      config: { offerTools: [] },
      inputs: { agentId: entry.rosterId, task: 'send a short encouraging nudge', credentialRef: 'managed:openwop-free' },
      callAI,
      callAIWithTools,
    }));

    expect(out.status, JSON.stringify(out)).toBe('success');
    expect(callAI).toHaveBeenCalledTimes(1);
    const outputs = (out as { outputs: Record<string, unknown> }).outputs;
    expect(outputs.agentId, 'the dispatched agent is the one the roster entry wraps').toBe('test.roster-wrapped');
  });

});
