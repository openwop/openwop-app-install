/**
 * ADR 0081 Phase 3 — live agent tool execution (node-as-tool projection).
 *
 * The suite's PURE compute nodes (variance-compute, talent-score) are projected as live
 * agent tools so a dispatched agent can call them for real; connector-backed nodes
 * (bigquery.query, email.draft) are deliberately NOT projected (they need the executor
 * broker ctx — meta-workflow path only). Verifies resolution, real execution, fail-closed,
 * and the connector-node exclusion.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { nodes as insightsNodes } from '../../../packs/feature.insights-suite.nodes/index.mjs';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeModule, NodeOutcome } from '../src/executor/types.js';
import { builtinAgentToolIds, createAgentToolProvider } from '../src/host/agentToolProvider.js';

const VARIANCE = 'openwop:feature.insights-suite.nodes.variance-compute';
const TALENT = 'openwop:feature.insights-suite.nodes.talent-score';

beforeAll(() => {
  // Register the pure compute nodes so the projection's registry lookup resolves them.
  const reg = getNodeRegistry();
  for (const [typeId, fn] of Object.entries(insightsNodes)) {
    const execute: NodeModule['execute'] = async (ctx) => (await fn(ctx)) as NodeOutcome;
    reg.register({ typeId, version: '1.0.0', execute });
  }
});

describe('ADR 0081 §3 — node-as-tool projection', () => {
  it('projects the pure compute nodes as live agent tools (with a def)', () => {
    expect(builtinAgentToolIds()).toEqual(expect.arrayContaining([VARIANCE, TALENT, 'openwop:knowledge.search']));
    const p = createAgentToolProvider({ tenantId: 'tenant-a' });
    expect(p.resolveTool(VARIANCE)?.inputSchema).toMatchObject({ type: 'object' });
    expect(p.resolveTool(TALENT)?.name).toBe(TALENT); // resolveTool returns the AgentToolDef directly
  });

  it('does NOT project connector-backed nodes (they need the broker ctx — meta-workflow only)', () => {
    const p = createAgentToolProvider({ tenantId: 'tenant-a' });
    expect(p.resolveTool('openwop:core.bigquery.query')).toBeUndefined();
    expect(p.resolveTool('openwop:core.email.draft')).toBeUndefined();
  });

  it('executeTool runs variance-compute for real (deterministic)', async () => {
    const p = createAgentToolProvider({ tenantId: 'tenant-a' });
    const r = await p.executeTool({ name: VARIANCE, input: { businessUnit: 'BU1', actuals: { sales: 90 }, plan: { sales: 100 } } });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content) as { verdict: string; flagged: Array<{ metric: string }> };
    expect(out.verdict).toBe('off_plan');
    expect(out.flagged.map((f) => f.metric)).toContain('sales');
  });

  it('executeTool runs talent-score; missing subjectId fails closed (isError)', async () => {
    const p = createAgentToolProvider({ tenantId: 'tenant-a' });
    const ok = await p.executeTool({ name: TALENT, input: { subjectId: 'subj-x', performance: 3, potential: 3 } });
    expect(ok.isError).toBeFalsy();
    expect((JSON.parse(ok.content) as { box: number }).box).toBe(9);
    const bad = await p.executeTool({ name: TALENT, input: { performance: 2, potential: 2 } });
    expect(bad.isError).toBe(true);
  });
});
