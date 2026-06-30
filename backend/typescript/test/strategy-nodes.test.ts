/**
 * feature.strategy.nodes pack (ADR 0080 Phase B) — drives each node function
 * against a mock `ctx` (the surface contract), so the pack's wiring is verified
 * without a registry install. Confirms: read nodes pass through the surface;
 * create-board-memo writes to Documents; the documents-OFF + missing-input
 * degrade paths; and the capability error when the strategy surface is absent.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
// Plain ESM pack (typed via test/feature-packs.d.ts) — literal specifier so
// vitest resolves it statically, no suppression needed.
import { nodes } from '../../../packs/feature.strategy.nodes/index.mjs';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const AGENT_PACK = join(REPO_ROOT, 'packs', 'feature.strategy.agents');

const strategySurface = {
  listStrategies: async () => ({ strategies: [{ id: 's1', title: 'North Star', scope: 'org', status: 'active', horizon: 'annual' }] }),
  getStrategy: async ({ id }: { id: string }) => ({ strategy: id === 's1' ? { id: 's1', title: 'North Star', objectives: [], links: [] } : null }),
  getStrategyContext: async () => ({ strategies: [{ id: 's1', title: 'North Star', health: { health: 'at-risk' } }] }),
  getHealth: async () => ({ strategies: [{ id: 's1', title: 'North Star', health: 'at-risk', signals: { linkedProjectCount: 1 } }] }),
};

describe('feature.strategy.nodes', () => {
  it('exposes exactly the five declared nodes', () => {
    expect(Object.keys(nodes).sort()).toEqual([
      'feature.strategy.nodes.create-board-memo',
      'feature.strategy.nodes.get-context',
      'feature.strategy.nodes.get-health',
      'feature.strategy.nodes.get-strategy',
      'feature.strategy.nodes.list-strategies',
    ]);
  });

  it('list-strategies passes the surface result through', async () => {
    const r = await nodes['feature.strategy.nodes.list-strategies']({ features: { strategy: strategySurface } });
    expect(r).toEqual({ status: 'success', outputs: { strategies: [{ id: 's1', title: 'North Star', scope: 'org', status: 'active', horizon: 'annual' }] } });
  });

  it('get-strategy returns the strategy by id (null for unknown)', async () => {
    const ctx = (id: string) => ({ features: { strategy: strategySurface }, inputs: { id } });
    expect(await nodes['feature.strategy.nodes.get-strategy'](ctx('s1'))).toMatchObject({ status: 'success', outputs: { strategy: { title: 'North Star' } } });
    expect(await nodes['feature.strategy.nodes.get-strategy'](ctx('nope'))).toEqual({ status: 'success', outputs: { strategy: null } });
  });

  it('get-health surfaces the rollup + signals', async () => {
    expect(await nodes['feature.strategy.nodes.get-health']({ features: { strategy: strategySurface } }))
      .toEqual({ status: 'success', outputs: { strategies: [{ id: 's1', title: 'North Star', health: 'at-risk', signals: { linkedProjectCount: 1 } }] } });
  });

  it('get-context resolves by a consumer ref', async () => {
    expect(await nodes['feature.strategy.nodes.get-context']({ features: { strategy: strategySurface }, inputs: { projectId: 'p1' } }))
      .toMatchObject({ status: 'success', outputs: { strategies: [{ id: 's1' }] } });
  });

  it('create-board-memo persists agent-authored markdown to Documents', async () => {
    let created: Record<string, unknown> = {}, versioned: Record<string, unknown> = {};
    const documents = {
      createDocument: async (a: Record<string, unknown>) => { created = a; return { document: { documentId: 'doc-1' } }; },
      addVersion: async (a: Record<string, unknown>) => { versioned = a; return { version: { versionId: 'v1' } }; },
    };
    const r = await nodes['feature.strategy.nodes.create-board-memo']({
      features: { strategy: strategySurface, documents },
      inputs: { orgId: 'org-1', strategyId: 's1', title: 'Q3 board update', markdown: '# Q3\nOn the rails.' },
    });
    expect(r).toMatchObject({ status: 'success', outputs: { persisted: true, documentId: 'doc-1', strategyId: 's1' } });
    expect(created.kind).toBe('board-update');
    expect(versioned.content).toContain('On the rails');
    expect(String(versioned.idempotencyKey)).toContain('s1');
  });

  it('create-board-memo degrades to inline markdown when documents is OFF', async () => {
    const r = await nodes['feature.strategy.nodes.create-board-memo']({
      features: { strategy: strategySurface }, // no documents surface
      inputs: { orgId: 'org-1', strategyId: 's1', markdown: '# memo' },
    });
    expect(r).toEqual({ status: 'success', outputs: { persisted: false, markdown: '# memo', strategyId: 's1' } });
  });

  it('create-board-memo validates required inputs', async () => {
    const r = await nodes['feature.strategy.nodes.create-board-memo']({ features: { strategy: strategySurface }, inputs: { orgId: 'org-1' } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('validation_error');
  });

  it('a read node fails with the capability error when the strategy surface is absent', async () => {
    await expect(nodes['feature.strategy.nodes.list-strategies']({ features: {} })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });
});

describe('feature.strategy.agents — agent pack manifest', () => {
  beforeEach(() => getAgentRegistry()._resetForTest());

  it('loads the strategy-analyst with its prompt + tool allowlist (memo node included)', () => {
    const loaded = loadAgentsFromManifest(AGENT_PACK);
    expect(loaded.length).toBe(1);
    const a = loaded[0];
    expect(a.agentId).toBe('feature.strategy.agents.strategy-analyst');
    expect(a.systemPromptRef).toBe('prompts/strategy-analyst.md');
    expect(a.systemPrompt.length).toBeGreaterThan(0);
    // tool-allowlisted to its OWN nodes only (read + the Documents-writing memo node).
    const allow = a.toolAllowlist ?? [];
    expect(allow).toContain('openwop:feature.strategy.nodes.get-health');
    expect(allow).toContain('openwop:feature.strategy.nodes.create-board-memo');
    // read-only-strategy invariant: NO strategy-mutation tool is allowlisted.
    expect(allow.some((tool: string) => /strategy\.nodes\.(create-strategy|update|delete|replace-links)/.test(tool))).toBe(false);
    expect(getAgentRegistry().listAgentIds()).toContain(a.agentId);
  });
});
