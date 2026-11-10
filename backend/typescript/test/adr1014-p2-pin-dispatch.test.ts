/**
 * ADR 1014 P2 — the pinned version is the version that runs (D3), and an
 * archived version runs with its own tools or not at all (D6).
 *
 * The dispatcher is driven with a real registry holding a head (2.0.0) and an
 * archived 1.0.0 beside it. The model is pinned to the off-catalog `mock`
 * provider and the injected `callAI` records the system prompt it was handed and
 * throws, so every turn ends `provider_error` having reached the model call with
 * the SELECTED manifest: its persona and its own system prompt are the claim.
 * (Corrected w83: this used to say the turn stops at `no_model_available`; an
 * unknown model class falls back to the catalog's `chat` default, so it never did.)
 *
 * Red when: a pinned dispatch runs the head (or any other version) instead of
 * the pin; an unknown version falls back instead of failing typed; an archived
 * version whose allowlist names a tool this host no longer offers runs without it
 * (today's silent `filterTools` drop); or the head starts failing on a missing
 * tool (D6 is for archived versions only).
 *
 * Sabotage-witnessed (grade-tests w83): resolving the head when a version is
 * named, dropping the typed unavailable error, dropping the D6 refusal, applying
 * D6 to the head, and treating a tool the host knows (`resolveTool`) as missing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAgentRegistry, type ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import {
  AgentNotFoundError, AgentVersionUnavailableError, runAgentDispatchLive, type AgentDispatchResult, type AgentToolDef, type LiveDispatchDeps,
} from '../src/host/agentDispatch.js';

const AGENT = 'acme.agents.pinned.a';
const manifest = (version: string, persona: string, tools: string[]): ResolvedAgentManifest => ({
  agentId: AGENT, persona, modelClass: 'no-such-model-class', systemPrompt: `I am ${version}.`,
  toolAllowlist: tools, packName: 'acme.agents.pinned', packVersion: version,
});
let prompts: Array<string | undefined> = [];
const deps: LiveDispatchDeps = {
  callAI: async (req) => { prompts.push(req.systemPrompt); throw new Error('no provider in this test'); },
  modelOptions: { provider: 'mock', model: 'mock' },
};
/** The turn reached the model call with `version`'s own prompt, and failed there. */
const ranAtModel = (r: AgentDispatchResult, version: string): void => {
  expect(r.status).toBe('failed');
  expect(r.error?.code).toBe('provider_error');
  expect(prompts.at(-1), 'the selected manifest\u2019s prompt reached the model').toBe(`I am ${version}.`);
};

beforeEach(() => {
  prompts = [];
  const r = getAgentRegistry();
  r._resetForTest();
  r.register(manifest('2.0.0', 'Head', ['t1']));
  r.registerVersion(manifest('1.0.0', 'Old', ['t1', 't-gone']));
});
afterEach(() => getAgentRegistry()._resetForTest());

describe('ADR 1014 D3 — a pinned dispatch runs exactly the pinned version', () => {
  it('no version runs the head; version 1.0.0 runs 1.0.0', async () => {
    const head = await runAgentDispatchLive({ agentId: AGENT, task: 'x', availableTools: ['t1', 't-gone'] }, deps);
    ranAtModel(head, '2.0.0');
    expect(head.persona).toBe('Head');
    const old = await runAgentDispatchLive({ agentId: AGENT, version: '1.0.0', task: 'x', availableTools: ['t1', 't-gone'] }, deps);
    ranAtModel(old, '1.0.0');
    expect(old.persona).toBe('Old');
    expect((await runAgentDispatchLive({ agentId: AGENT, version: '2.0.0', task: 'x', availableTools: ['t1'] }, deps)).persona).toBe('Head');
  });

  it('a version this host cannot load fails typed, never falls back; an absent agent stays agent_not_found', async () => {
    const unavailable = await runAgentDispatchLive({ agentId: AGENT, version: '9.9.9', task: 'x' }, deps).catch((e: unknown) => e);
    expect(unavailable).toBeInstanceOf(AgentVersionUnavailableError);
    expect(unavailable).toMatchObject({ agentId: AGENT, version: '9.9.9', missingTools: [] });
    const absent = await runAgentDispatchLive({ agentId: 'acme.agents.absent', version: '1.0.0', task: 'x' }, deps).catch((e: unknown) => e);
    expect(absent).toBeInstanceOf(AgentNotFoundError);
    expect(absent).toMatchObject({ agentId: 'acme.agents.absent' });
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
    ranAtModel(r, '2.0.0');
    expect(r.persona).toBe('Head');
    expect(r.toolSurface).toEqual([]);
  });

  it('a tool the host knows but the caller did not offer is the caller\u2019s narrowing, not a missing tool (review M4)', async () => {
    const known: LiveDispatchDeps = {
      ...deps,
      resolveTool: (name: string): AgentToolDef | undefined => (name === 't-gone' ? { name, description: 'd', inputSchema: {} } : undefined),
    };
    const r = await runAgentDispatchLive({ agentId: AGENT, version: '1.0.0', task: 'x', availableTools: ['t1'] }, known);
    ranAtModel(r, '1.0.0');
    expect(r.persona).toBe('Old');
  });
});
