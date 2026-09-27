/**
 * Insights & Drafting Agent Suite foundation (ADR 0078, guards ADR 0599).
 *
 * Verifies (a) the 2 compute nodes (variance-compute / talent-score) math AND their
 * ADR 0599 fail-closed guards, (b) the talent-snapshot PII classification — of the RUN
 * OUTPUT; ADR 0082 deleted the read model this header used to name, (c) the 3 agents
 * load + list in GET /v1/agents under the feature.insights-suite.agents.* ids, and
 * (d) the config route fails closed when the toggle is OFF.
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
    // The verdict is only ever as wide as the metrics behind it (ADR 0599 §3).
    expect(outs(res).metricsEvaluated).toEqual(['sales']);
    expect(outs(res).metricsMissing).toEqual(['margin', 'labor', 'shrink']);
  });

  it('variance-compute: reads a tabular rows set (the source-node shape)', async () => {
    const res = await variance({
      inputs: { businessUnit: 'TX', rows: [{ metric: 'sales', actual: 95, plan: 100 }, { metric: 'labor', actual: 22, plan: 20 }] },
    });
    expect(res.status).toBe('success');
    expect(outs(res).verdict).toBe('off_plan');
    expect(outs(res).metricsEvaluated).toEqual(['sales', 'labor']);
  });

  // ── ADR 0599 §3 — THE FABRICATION GUARDS ──────────────────────────────────
  // These two are the reason the node pack went 1.0.0 → 1.1.0. Both nodes used to
  // answer a zero-data call with a confident verdict under `status:'success'`;
  // neither was reachable because every chain died upstream at `invalid_config`,
  // which is exactly why the guards had to land BEFORE the wiring repair.
  it('variance-compute: FAILS CLOSED on zero evaluable metrics — never "on_plan" from nothing', async () => {
    // Exactly what the weekly-variance chain delivers: `core.bigquery.query`'s
    // outputs arriving over a portless edge, with no metric columns in them.
    const res = await variance({ inputs: { rows: [{ a: 1 }], rowCount: 1, sql: 'SELECT 1', projectId: 'p', businessUnit: 'TX' } });
    expect(res.status).toBe('failure');
    expect(res.error?.code).toBe('insufficient_data');
    expect(outs(res).verdict).toBeUndefined();
  });

  // ── ADR 0599 §Correction 1 — the guards above did not see the real absence ──
  // 1.1.0 read every cell through `Number()`, where `null`, `''`, `'  '` and
  // `false` are all **0**. The node-level coercion table, pinned so the class
  // cannot come back through a "simplify the reader" refactor. PROBE-IS-3 in
  // `insights-chain-execution.test.ts` proves the same thing through a real chain.
  it.each([
    ['SQL NULL', null],
    ['blank string', ''],
    ['whitespace', '   '],
    ['boolean false', false],
  ])('variance-compute: a %s cell is an ABSENCE, never a measurement of zero', async (_label, cell) => {
    // The actuals table has not loaded; the plan table has. Under `Number()`
    // every actual coerced to a real 0 against a real plan — `pct === -1` on
    // every metric — and the chain reported a fabricated 100% collapse as a
    // successful `off_plan` verdict for a human to red-team.
    const res = await variance({
      inputs: { rows: [{ metric: 'sales', actual: cell, plan: 100 }, { metric: 'labor', actual: cell, plan: 20 }] },
    });
    expect(res.status).toBe('failure');
    expect(res.error?.code).toBe('insufficient_data');
    expect(outs(res).verdict).toBeUndefined();
  });

  it('variance-compute: a numeric STRING is still a measurement (the BigQuery REST wire)', async () => {
    // `jobs.query` returns every cell as a string. An absence-strict reader that
    // rejected strings would starve the one source the variance chain has.
    const res = await variance({ inputs: { rows: [{ metric: 'sales', actual: '95', plan: '100' }] } });
    expect(res.status).toBe('success');
    expect((outs(res).variances as Record<string, unknown>).sales).toEqual({ actual: 95, plan: 100, delta: -5, pct: -0.05 });
  });

  it('variance-compute: every metric on a ZERO plan is an unloaded plan, not "on plan"', async () => {
    // `SUM(plan)` over a table with no plan rows returns 0, not NULL. `pct` is
    // then null for every metric, so nothing can EVER be flagged and
    // `flagged.length === 0` reported "checked and clean" — §3's conflation, one
    // layer in. The delta is still real data, so it stays in `variances`; what it
    // may not do is produce a verdict.
    const res = await variance({ inputs: { rows: [{ metric: 'sales', actual: 482000, plan: 0 }, { metric: 'margin', actual: 31, plan: 0 }] } });
    expect(res.status).toBe('failure');
    expect(res.error?.code).toBe('insufficient_data');
    expect(outs(res).verdict).toBeUndefined();
    // One comparable metric is enough to earn a verdict, and the uncomparable one
    // is named rather than silently counted as agreement.
    const mixed = await variance({ inputs: { rows: [{ metric: 'sales', actual: 100, plan: 100 }, { metric: 'margin', actual: 31, plan: 0 }] } });
    expect(mixed.status).toBe('success');
    expect(outs(mixed).verdict).toBe('on_plan');
    expect(outs(mixed).metricsUncomparable).toEqual(['margin']);
  });

  it('talent-score: 9-box mapping + readiness', async () => {
    const star = await talent({ inputs: { subjectId: 'u1', performance: 3, potential: 3 } });
    expect(outs(star)).toMatchObject({ subjectId: 'u1', box: 9, label: 'Star', readiness: 'ready_now' });
    const core = await talent({ inputs: { subjectId: 'u2', performance: 2, potential: 2 } });
    expect(outs(core)).toMatchObject({ box: 5, readiness: 'developing' });
  });

  // SCOPED DELIBERATELY (ADR 0599 §3). This assertion used to be the last line of
  // the 9-box test and it is the reason nobody asked what an ABSENT rating does:
  // it pinned coercion-of-a-supplied-value as the contract, and `clamp13` applied
  // the same coercion to `undefined`. Clamping a value the caller actually supplied
  // is legitimate and stays; ABSENCE is now a typed failure, and the two cases are
  // asserted separately so neither can be mistaken for the other again.
  it('talent-score: clamps out-of-range SUPPLIED ratings into 1-3 (absence is a different case)', async () => {
    const clamped = await talent({ inputs: { subjectId: 'u3', performance: 9, potential: 0 } });
    expect(clamped.status).toBe('success');
    expect(outs(clamped)).toMatchObject({ performance: 3, potential: 1, box: 3 });
  });

  it('talent-score: FAILS CLOSED when a rating is ABSENT — never box 1 / Underperformer from nothing', async () => {
    // Exactly what the talent-prep chain delivers: `core.workday.query`'s outputs
    // over a portless edge + the declared `subjectId`, and no ratings anywhere.
    const res = await talent({ inputs: { rows: [], rowCount: 0, resource: 'performanceReviews', baseUrl: 'https://x', subjectId: 'subj-42' } });
    expect(res.status).toBe('failure');
    expect(res.error?.code).toBe('insufficient_data');
    expect(outs(res).box).toBeUndefined();
    expect(outs(res).readiness).toBeUndefined();
    // One-sided absence fails too — a supplied performance must not carry a
    // fabricated potential into a cell.
    const half = await talent({ inputs: { subjectId: 'subj-42', performance: 3 } });
    expect(half.status).toBe('failure');
    expect(half.error?.code).toBe('insufficient_data');
  });

  it('talent-score: reads ratings out of a rows review set matched on subjectId', async () => {
    const res = await talent({
      inputs: { subjectId: 'subj-42', rows: [{ workerId: 'other', performanceRating: 1, potentialRating: 1 }, { workerId: 'subj-42', performanceRating: 3, potentialRating: 3 }] },
    });
    expect(res.status).toBe('success');
    expect(outs(res)).toMatchObject({ subjectId: 'subj-42', box: 9, readiness: 'ready_now' });
    // ADR 0599 §Correction 4 — the value the source gave, beside the value scored.
    expect(outs(res)).toMatchObject({ performanceRaw: 3, ratingSource: { performance: 'rows', potential: 'rows' } });
  });

  // ── ADR 0599 §Correction 1/4 — talent-score's half ─────────────────────────
  it.each([
    ['blank string', ''],
    ['whitespace', '   '],
    ['boolean false', false],
  ])('talent-score: a %s rating column is ABSENCE, not the worst possible rating', async (_label, cell) => {
    // 1.1.0's `clamp13` ran the cell through `Number()`, so a blank column became
    // 0, then `Math.max(1, …)` made it 1: box 1, "Underperformer", "not_ready",
    // about a NAMED PERSON, broadcast tenant-wide as confidential-pii.
    const res = await talent({ inputs: { subjectId: 'subj-42', rows: [{ workerId: 'subj-42', performanceRating: cell, potentialRating: cell }] } });
    expect(res.status).toBe('failure');
    expect(res.error?.code).toBe('insufficient_data');
    expect(outs(res).box).toBeUndefined();
  });

  it('talent-score: review cycles that DISAGREE are ambiguous, not "whichever row came first"', async () => {
    // A `performanceReviews` pull returns one row PER CYCLE, in collection order,
    // with no recency field this node may trust. 1.1.0 took the first row that
    // carried any rating — an arbitrary cycle, presented as the current rating.
    const res = await talent({
      inputs: { subjectId: 'subj-42', rows: [
        { workerId: 'subj-42', cycle: '2024', performanceRating: 1, potentialRating: 1 },
        { workerId: 'subj-42', cycle: '2026', performanceRating: 3, potentialRating: 3 },
      ] },
    });
    expect(res.status).toBe('failure');
    expect(res.error?.code).toBe('ambiguous_data');
    // The SAME value repeated across cycles is not a conflict.
    const agreed = await talent({
      inputs: { subjectId: 'subj-42', rows: [
        { workerId: 'subj-42', performanceRating: 3, potentialRating: 2 },
        { workerId: 'subj-42', performanceRating: 3, potentialRating: 2 },
      ] },
    });
    expect(agreed.status).toBe('success');
    expect(outs(agreed)).toMatchObject({ box: 6 });
  });

  it('talent-score: a ROW rating outside 1-3 is an unknown scale, never a clamp', async () => {
    // §3 justifies clamping "a value the caller actually supplied" — the caller
    // asserted this node's 1-3 contract. That does NOT transfer to a scraped
    // column whose scale the node cannot know: on a 1-5 scale a mid 3 already
    // reads as the top band, and clamping 4/5 down to 3 makes it worse silently.
    const res = await talent({ inputs: { subjectId: 'subj-42', rows: [{ workerId: 'subj-42', performanceRating: 4, potentialRating: 5 }] } });
    expect(res.status).toBe('failure');
    expect(res.error?.code).toBe('unknown_scale');
    expect(outs(res).box).toBeUndefined();
  });

  it('talent-score: an unfilled parameter does NOT shadow rows that have the data', async () => {
    // An unfilled `{{params.performance}}` freezes to the empty string (ADR 0507).
    // Treating that as "supplied" would starve a chain whose rows are fine.
    const res = await talent({
      inputs: { subjectId: 'subj-42', performance: '', potential: '', rows: [{ workerId: 'subj-42', performanceRating: 3, potentialRating: 2 }] },
    });
    expect(res.status).toBe('success');
    expect(outs(res)).toMatchObject({ box: 6, ratingSource: { performance: 'rows' } });
  });

  it('talent-score: fails closed without a subjectId', async () => {
    const res = await talent({ inputs: { performance: 2, potential: 2 } });
    expect(res.status).toBe('failure');
  });
});

// ADR 0599 §7 — this block used to be titled 'read model PII classification' for a
// read model ADR 0082 DELETED. The DECLARATION is still real and still load-bearing
// (it masks `subjectId` in logs of the run OUTPUT, which is where the 9-box result
// lives now), so the assertion stays and the name stops describing a deleted store.
describe('ADR 0077 — talent-snapshot PII classification (run output, not a store)', () => {
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
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
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
