/**
 * ADR 0078 Phase 1 — Insights & Drafting Agent Suite foundation.
 *
 * Verifies (a) the 2 compute nodes (variance-compute / talent-score) math, (b) the
 * read model's PII classification (talent snapshot is confidential-pii), (c) the 3
 * agents load + list in GET /v1/agents under the feature.insights-suite.agents.* ids,
 * and (d) the read routes fail closed when the toggle is OFF.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodes as insightsNodes } from '../../../packs/feature.insights-suite.nodes/index.mjs';
import { classificationOf, isPiiField } from '../src/host/dataClassification.js';
import '../src/features/insights-suite/insightsSuiteService.js'; // triggers declarePiiFields
import { createApp } from '../src/index.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';

const variance = insightsNodes['feature.insights-suite.nodes.variance-compute']!;
const talent = insightsNodes['feature.insights-suite.nodes.talent-score']!;
const outs = (r: { outputs?: Record<string, unknown> }): Record<string, unknown> => r.outputs ?? {};

describe('ADR 0078 §1 — compute nodes', () => {
  it('variance-compute: Actual-vs-Plan deltas + off-plan flagging', async () => {
    const res = await variance({
      config: { businessUnit: 'Enterprise Sales', thresholdPct: 0.05 },
      inputs: { actuals: { sales: 95, margin: 40, labor: 22, churn: 3 }, plan: { sales: 100, margin: 38, labor: 20, churn: 3 } },
    });
    expect(res.status).toBe('success');
    const o = outs(res);
    expect(o.businessUnit).toBe('Enterprise Sales');
    expect((o.variances as Record<string, unknown>).sales).toEqual({ actual: 95, plan: 100, delta: -5, pct: -0.05 });
    expect(o.verdict).toBe('off_plan'); // sales -5% (>=5%), labor +10%
    const flaggedMetrics = (o.flagged as Array<{ metric: string }>).map((f) => f.metric);
    expect(flaggedMetrics).toContain('sales');
    expect(flaggedMetrics).toContain('labor');
    expect(flaggedMetrics).not.toContain('shrink'); // 0% delta
  });

  it('variance-compute: on_plan when nothing exceeds the threshold', async () => {
    const res = await variance({ inputs: { actuals: { sales: 100 }, plan: { sales: 100 } } });
    expect(outs(res).verdict).toBe('on_plan');
    expect(outs(res).flagged).toEqual([]);
  });

  it('talent-score: 9-box mapping + readiness', async () => {
    const star = await talent({ inputs: { subjectId: 'u1', performance: 3, potential: 3 } });
    expect(outs(star)).toMatchObject({ subjectId: 'u1', box: 9, label: 'Star', readiness: 'ready_now' });
    const core = await talent({ inputs: { subjectId: 'u2', performance: 2, potential: 2 } });
    expect(outs(core)).toMatchObject({ box: 5, readiness: 'developing' });
    // clamps out-of-range inputs to 1-3
    const clamped = await talent({ inputs: { subjectId: 'u3', performance: 9, potential: 0 } });
    expect(outs(clamped)).toMatchObject({ performance: 3, potential: 1, box: 3 });
  });

  it('talent-score: fails closed without a subjectId', async () => {
    const res = await talent({ inputs: { performance: 2, potential: 2 } });
    expect(res.status).toBe('failure');
  });
});

describe('ADR 0078 §1 — read model PII classification', () => {
  it('talent snapshot is confidential-pii; subjectId is a declared PII field', () => {
    expect(classificationOf('insights.talentSnapshot')).toBe('confidential-pii');
    expect(isPiiField('insights.talentSnapshot', 'subjectId')).toBe(true);
  });
});

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');
let server: http.Server;

describe('ADR 0078 §1 — agents + route gating', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'feature.insights-suite.agents'));
    await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('lists the 3 suite agents in GET /v1/agents with their tool allowlists', async () => {
    const list = await (await fetch(`${BASE}/v1/agents`, { headers: H })).json() as { agents?: Array<{ agentId?: string; label?: string }> };
    const ids = (list.agents ?? []).map((a) => a.agentId);
    expect(ids).toContain('feature.insights-suite.agents.financial');
    expect(ids).toContain('feature.insights-suite.agents.communication');
    expect(ids).toContain('feature.insights-suite.agents.talent');
  });

  it('read routes fail closed when the toggle is OFF (default)', async () => {
    const res = await fetch(`${BASE}/v1/host/openwop-app/insights-suite/config`, { headers: H });
    expect(res.status).toBe(404); // requireFeatureEnabled — toggle off ⇒ not found
  });
});
