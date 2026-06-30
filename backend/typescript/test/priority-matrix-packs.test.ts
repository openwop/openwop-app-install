/**
 * Priority Matrix packs (ADR 0058 Phase 4) — the node pack's behaviour over a
 * stubbed `ctx.features['priority-matrix']` surface + the agent pack manifest
 * loading (systemPromptRef + tool-allowlist). Mirrors agent-loader.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
// The node pack is plain ESM (typed via test/feature-packs.d.ts) — import the
// `nodes` map and exercise the node fns directly.
import { nodes as nodePack } from '../../../packs/feature.priority-matrix.nodes/index.mjs';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const AGENT_PACK = join(REPO_ROOT, 'packs', 'feature.priority-matrix.agents');
const ASSISTANT_PACK = join(REPO_ROOT, 'packs', 'feature.assistant.agents');

describe('feature.priority-matrix.nodes — node pack', () => {
  it('exports the seven priority-matrix node fns', () => {
    expect(Object.keys(nodePack).sort()).toEqual([
      'feature.priority-matrix.nodes.generate-agenda',
      'feature.priority-matrix.nodes.list-lists',
      'feature.priority-matrix.nodes.list-portfolio',
      'feature.priority-matrix.nodes.list-ranked-ideas',
      'feature.priority-matrix.nodes.schedule-status',
      'feature.priority-matrix.nodes.score-idea',
      'feature.priority-matrix.nodes.submit-idea',
    ]);
  });

  it('fails closed with host_capability_missing when the surface is absent', async () => {
    const node = nodePack['feature.priority-matrix.nodes.list-lists'];
    await expect(node({ features: {} })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });

  it('calls the surface and shapes the output on success', async () => {
    const calls: Record<string, unknown> = {};
    const features = {
      'priority-matrix': {
        listLists: async () => ({ lists: [{ listId: 'plist-1', name: 'Strategic' }] }),
        submitIdea: async (a: unknown) => { calls.submit = a; return { cardId: 'card-1', title: 'Idea', status: 'new' }; },
        scoreIdea: async (a: unknown) => { calls.score = a; return { cardId: 'card-1', computedPriority: 7.5 }; },
      },
    };
    const list = await nodePack['feature.priority-matrix.nodes.list-lists']({ features, inputs: {} });
    expect(list).toEqual({ status: 'success', outputs: { lists: [{ listId: 'plist-1', name: 'Strategic' }] } });

    const submit = await nodePack['feature.priority-matrix.nodes.submit-idea']({ features, inputs: { listId: 'plist-1', title: 'Idea' } });
    expect(submit.status).toBe('success');
    expect(calls.submit).toEqual({ listId: 'plist-1', title: 'Idea' });

    const score = await nodePack['feature.priority-matrix.nodes.score-idea']({ features, inputs: { listId: 'plist-1', cardId: 'card-1', scores: { roi: 9 } } });
    expect(score.outputs).toEqual({ cardId: 'card-1', computedPriority: 7.5 });
    expect(calls.score).toEqual({ listId: 'plist-1', cardId: 'card-1', scores: { roi: 9 } });
  });

  it('schedule-status calls the surface and shapes { ideas, rollup } (ADR 0103)', async () => {
    let arg: unknown;
    const features = {
      'priority-matrix': {
        listLists: async () => ({ lists: [] }), // present so ensurePriorityMatrix passes
        getScheduleStatus: async (a: unknown) => {
          arg = a;
          return { ideas: [{ cardId: 'card-1', title: 'X', status: 'New', state: 'behind', overdueByDays: 4 }], rollup: { behind: 1, atRisk: 0, onTrack: 0, doneLate: 0, doneEarly: 0, unscheduled: 0, total: 1, health: 'behind' } };
        },
      },
    };
    const out = await nodePack['feature.priority-matrix.nodes.schedule-status']({ features, inputs: { listId: 'plist-1' } });
    expect(out.status).toBe('success');
    expect(arg).toEqual({ listId: 'plist-1' });
    expect(out.outputs).toEqual({
      ideas: [{ cardId: 'card-1', title: 'X', status: 'New', state: 'behind', overdueByDays: 4 }],
      rollup: { behind: 1, atRisk: 0, onTrack: 0, doneLate: 0, doneEarly: 0, unscheduled: 0, total: 1, health: 'behind' },
    });
  });
});

describe('feature.priority-matrix.agents — agent pack manifest', () => {
  beforeEach(() => getAgentRegistry()._resetForTest());

  it('loads the prioritization-analyst with its prompt + tool allowlist', () => {
    const loaded = loadAgentsFromManifest(AGENT_PACK);
    expect(loaded.length).toBe(1);
    const a = loaded[0];
    expect(a.agentId).toBe('feature.priority-matrix.agents.prioritization-analyst');
    expect(a.systemPromptRef).toBe('prompts/prioritization-analyst.md');
    expect(a.systemPrompt.length).toBeGreaterThan(0);
    expect(a.toolAllowlist).toContain('openwop:feature.priority-matrix.nodes.score-idea');
    expect(a.toolAllowlist).toContain('openwop:feature.priority-matrix.nodes.schedule-status');
    expect(getAgentRegistry().listAgentIds()).toContain(a.agentId);
  });

  // ADR 0103 Phase 2 — the Chief of Staff (Iris) can answer "are we behind schedule?"
  // because the schedule-status node is on her allowlist (the whole point of the wiring).
  it('grants the Chief of Staff the schedule-status node (ADR 0103)', () => {
    const cos = loadAgentsFromManifest(ASSISTANT_PACK).find((x) => x.agentId === 'feature.assistant.agents.chief-of-staff');
    expect(cos, 'chief-of-staff agent must load').toBeDefined();
    expect(cos?.toolAllowlist).toContain('openwop:feature.priority-matrix.nodes.schedule-status');
  });
});
