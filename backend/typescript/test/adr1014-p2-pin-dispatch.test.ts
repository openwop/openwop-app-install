/**
 * ADR 1014 P2 — the pinned version is the version that runs (D3), and an
 * archived version runs with its own tools or not at all (D6).
 *
 * The dispatcher is driven with a real registry holding a head (2.0.0) and an
 * archived 1.0.0 beside it. No provider is wired, so a turn stops at
 * `no_model_available`; the result still names the persona of the manifest that
 * was SELECTED, which is the claim.
 *
 * Red when: a pinned dispatch runs the head (or any other version) instead of
 * the pin; an unknown version falls back instead of failing typed; an archived
 * version whose allowlist names a tool this host no longer offers runs without it
 * (today's silent `filterTools` drop); or the head starts failing on a missing
 * tool (D6 is for archived versions only).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAgentRegistry, type ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import { AgentNotFoundError, AgentVersionUnavailableError, runAgentDispatchLive } from '../src/host/agentDispatch.js';

const AGENT = 'acme.agents.pinned.a';
const manifest = (version: string, persona: string, tools: string[]): ResolvedAgentManifest => ({
  agentId: AGENT, persona, modelClass: 'no-such-model-class', systemPrompt: `I am ${version}.`,
  toolAllowlist: tools, packName: 'acme.agents.pinned', packVersion: version,
});
const deps = { callAI: async () => { throw new Error('no provider in this test'); }, modelOptions: { preferManaged: true } };

beforeEach(() => {
  const r = getAgentRegistry();
  r._resetForTest();
  r.register(manifest('2.0.0', 'Head', ['t1']));
  r.registerVersion(manifest('1.0.0', 'Old', ['t1', 't-gone']));
});
afterEach(() => getAgentRegistry()._resetForTest());

describe('ADR 1014 D3 — a pinned dispatch runs exactly the pinned version', () => {
  it('no version runs the head; version 1.0.0 runs 1.0.0', async () => {
    expect((await runAgentDispatchLive({ agentId: AGENT, task: 'x', availableTools: ['t1', 't-gone'] }, deps)).persona).toBe('Head');
    expect((await runAgentDispatchLive({ agentId: AGENT, version: '1.0.0', task: 'x', availableTools: ['t1', 't-gone'] }, deps)).persona).toBe('Old');
    expect((await runAgentDispatchLive({ agentId: AGENT, version: '2.0.0', task: 'x', availableTools: ['t1'] }, deps)).persona).toBe('Head');
  });

  it('a version this host cannot load fails typed, never falls back; an absent agent stays agent_not_found', async () => {
    await expect(runAgentDispatchLive({ agentId: AGENT, version: '9.9.9', task: 'x' }, deps)).rejects.toBeInstanceOf(AgentVersionUnavailableError);
    await expect(runAgentDispatchLive({ agentId: 'acme.agents.absent', version: '1.0.0', task: 'x' }, deps)).rejects.toBeInstanceOf(AgentNotFoundError);
  });
});

describe('ADR 1014 D6 — an archived version runs with its own tools or not at all', () => {
  it('a tool the archived allowlist names but the host no longer offers refuses the dispatch, naming it', async () => {
    const err = await runAgentDispatchLive({ agentId: AGENT, version: '1.0.0', task: 'x', availableTools: ['t1'] }, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentVersionUnavailableError);
    expect((err as AgentVersionUnavailableError).missingTools).toEqual(['t-gone']);
  });

  it('the head keeps today’s behaviour: a missing tool is filtered, not refused', async () => {
    const r = await runAgentDispatchLive({ agentId: AGENT, version: '2.0.0', task: 'x', availableTools: [] }, deps);
    expect(r.persona).toBe('Head');
    expect(r.toolSurface).toEqual([]);
  });

  it('a tool the host knows but the caller did not offer is the caller\u2019s narrowing, not a missing tool (review M4)', async () => {
    const known = { ...deps, resolveTool: (name: string) => (name === 't-gone' ? { name, description: 'd', inputSchema: {} } : undefined) };
    const r = await runAgentDispatchLive({ agentId: AGENT, version: '1.0.0', task: 'x', availableTools: ['t1'] }, known as never);
    expect(r.persona).toBe('Old');
  });
});
