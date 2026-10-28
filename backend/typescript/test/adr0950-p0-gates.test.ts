/**
 * ADR 0950 P0 — the promotion gates (read-only).
 *
 *   1. Deterministic on a fixture: the same cells (in any order) give the same
 *      report and snapshot hash (THE P0 EXIT, first half).
 *   2. Each gate fails for its own reason, and only an all-pass checklist passes;
 *      a gate it cannot compute is `not_evaluable`, never a pass.
 *   3. Over the real CMS route, promoting a 3-session arm shows a red G2 (THE P0
 *      EXIT, second half), and the experiments route serves the same report.
 *
 * Sabotage (run 2026-10-20): counting `not_evaluable` as a pass reds 2's
 * no-winner case; dropping the sample leg of G2 reds 3; sorting nothing in
 * cellsHash reds 1.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __putRawEventForTests } from '../src/features/analytics/analyticsService.js';
import { createPage } from '../src/features/cms/cmsService.js';
import { createExperiment as createLegacy, startExperiment } from '../src/features/cms/pageExperimentsService.js';
import { evaluateGates, type GateReport } from '../src/host/experiments/gates.js';
import { verdictFromCells } from '../src/host/experiments/observe.js';
import type { ExperimentDailyCell } from '../src/host/experiments/rollup.js';
import type { Experiment } from '../src/host/experiments/types.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['experiments', 'analytics']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

// ── fixtures ──────────────────────────────────────────────────────────────────
const NOW = '2026-10-29T12:00:00.000Z';
const plan = { primaryMetric: { kind: 'conversion', name: 'signup' }, guardrails: [], baselineRate: 0.1, mde: 0.02, alpha: 0.05, power: 0.8, fdrQ: 0.05, minDays: 7, maxDays: 30, minSamplePerArm: 1000, lockedAt: '2026-10-01T00:00:00.000Z', planHash: 'h'.repeat(64) };
const exp = (over: Partial<Experiment> = {}): Experiment => ({
  experimentId: 'exp:g', tenantId: 't', orgId: 'o', name: 'Hero', hypothesis: '', surface: { kind: 'cms.page', ref: 'p' }, unit: 'visitor', design: { type: 'ab' },
  arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: 'v2', weight: 50 }], mode: 'decide', status: 'running', salt: 's', plan,
  epochs: [{ epoch: 0, weights: { control: 50, b: 50 }, at: '2026-10-01T00:00:00.000Z', reason: 'launch' }],
  createdBy: 'u', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', startedAt: '2026-10-01T00:00:00.000Z', ...over,
});
const cell = (arm: string, day: string, nUnits: number, sum: number): ExperimentDailyCell =>
  ({ cellId: `t::o::exp:g::${arm}::${day}::conversion`, tenantId: 't', orgId: 'o', experimentId: 'exp:g', arm, day, metric: 'conversion', n: nUnits, sum, sumSq: sum });
/** 28 days of steady traffic: control converts at 10%, b at `bRate`. */
function steady(bRate: number, perDay = 300, days = 28, start = '2026-10-01'): ExperimentDailyCell[] {
  const out: ExperimentDailyCell[] = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.parse(start) + d * 86_400_000).toISOString().slice(0, 10);
    out.push(cell('control', day, perDay, Math.round(perDay * 0.1)), cell('b', day, perDay, Math.round(perDay * bRate)));
  }
  return out;
}
const report = (e: Experiment, cells: ExperimentDailyCell[], content: { ok: boolean; reason?: string } | null = { ok: true }): GateReport =>
  evaluateGates({ experiment: e, cells, verdict: verdictFromCells(e, cells, 'complete', NOW), now: NOW, content });
const status = (r: GateReport): Record<string, string> => Object.fromEntries(r.gates.map((g) => [g.id, g.status]));

describe('ADR 0950 P0 — 1/2. the gates (pure)', () => {
  it('a clean winner passes all eight, deterministically and independent of cell order', () => {
    const cells = steady(0.14);
    const one = report(exp(), cells);
    expect(status(one)).toEqual({ G1: 'pass', G2: 'pass', G3: 'pass', G4: 'pass', G5: 'pass', G6: 'pass', G7: 'pass', G8: 'pass' });
    expect(one).toMatchObject({ allPass: true, winner: 'b' });
    const two = report(exp(), [...cells].reverse());
    expect(two).toEqual(one);
    expect(one.snapshot.cellsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('each gate fails for its own reason', () => {
    const g = (r: GateReport, id: string) => r.gates.find((x) => x.id === id)!;
    expect(g(report(exp({ legacy: true }), steady(0.14)), 'G1')).toMatchObject({ status: 'fail', reason: 'legacy_experiment' });
    // code-review: a STOPPED Decide test with a winner is never promotable (D2).
    const stopped = report(exp({ status: 'stopped', stoppedAt: '2026-10-29T00:00:00.000Z' }), steady(0.14));
    expect(g(stopped, 'G1')).toMatchObject({ status: 'fail', reason: 'not_running' });
    expect(stopped.allPass).toBe(false);
    expect(g(report(exp(), steady(0.14, 30)), 'G2')).toMatchObject({ status: 'fail', reason: 'below_sample' });
    expect(g(report(exp({ startedAt: '2026-10-26T00:00:00.000Z' }), steady(0.14, 300, 4, '2026-10-26')), 'G2')).toMatchObject({ status: 'fail', reason: 'too_short' });
    const lopsided = steady(0.14).map((c) => (c.arm === 'b' ? { ...c, n: c.n * 2, sum: c.sum * 2 } : c));
    expect(g(report(exp(), lopsided), 'G3')).toMatchObject({ status: 'fail', reason: 'sample_ratio_mismatch' });
    // A real but small lift: significant, below the MDE.
    expect(g(report(exp({ plan: { ...plan, mde: 0.05 } }), steady(0.14)), 'G5')).toMatchObject({ status: 'fail', reason: 'below_mde' });
    // Novelty: a strong early lift that has faded in the last week.
    const fading = steady(0.14).map((c) => (c.arm === 'b' && c.day >= '2026-10-23' ? { ...c, sum: Math.round(c.n * 0.105) } : c));
    expect(g(report(exp(), fading), 'G7')).toMatchObject({ status: 'fail' });
    expect(g(report(exp(), steady(0.14), { ok: false, reason: 'publish_blocked' }), 'G8')).toMatchObject({ status: 'fail', reason: 'publish_blocked' });
  });

  it('no winner: G4 fails and the gates that need one are not_evaluable, never a pass', () => {
    const r = report(exp(), steady(0.1));
    expect(status(r)).toMatchObject({ G4: 'fail', G5: 'not_evaluable', G7: 'not_evaluable', G8: 'not_evaluable' });
    expect(r.allPass).toBe(false);
    const noCheck = report(exp(), steady(0.14), null);
    expect(status(noCheck).G8).toBe('not_evaluable');
    expect(noCheck.allPass).toBe(false);
  });
});

describe('ADR 0950 P0 — 3. over the real routes', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON boundary
  async function call(cookie: { v: string }, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie.v ? { cookie: cookie.v } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m?.[1]) cookie.v = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  }

  it('promoting a 3-session arm shows a red G2 (the P0 exit); the experiments route serves the same report', async () => {
    const tenantId = `org:g0-${Date.now()}-${n++}`;
    const jar = { v: '' };
    await call(jar, 'POST', '/host/openwop-app/test/login', { email: `g0-${n++}@acme.test`, tenantId });
    const orgId = (await call(jar, 'POST', '/host/openwop-app/orgs', { name: 'Client' })).body.orgId as string;
    const page = await createPage({ tenantId, orgId, title: 'LP', createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    const legacy = await createLegacy({ tenantId, orgId, pageId: page.pageId, name: 'Old', variants: [{ key: 'a', versionId: null, weight: 50 }, { key: 'b', versionId: null, weight: 50 }], createdBy: 'u' });
    await startExperiment(tenantId, orgId, page.pageId, legacy.experimentId, 'u');
    for (const [arm, i] of [['a', 0], ['a', 1], ['b', 2]] as const) {
      await __putRawEventForTests({ eventId: `ev-${n++}`, tenantId, orgId, type: 'pageview', ts: new Date().toISOString(), sessionKey: `s-${i}`, experiment: { id: legacy.experimentId, variant: arm, derived: true } });
    }
    const cms = await call(jar, 'GET', `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(page.pageId)}/experiments/${encodeURIComponent(legacy.experimentId)}/gates`);
    expect(cms.status).toBe(200);
    const g2 = (cms.body as GateReport).gates.find((g) => g.id === 'G2')!;
    expect(g2).toMatchObject({ status: 'fail', reason: 'too_short_and_below_sample', value: { smallestArm: 1, minSamplePerArm: 30, floors: 'default_floors' } });
    expect((cms.body as GateReport).gates.find((g) => g.id === 'G1')).toMatchObject({ status: 'fail', reason: 'legacy_experiment' });
    const viaEngine = await call(jar, 'GET', `/host/openwop-app/experiments/orgs/${encodeURIComponent(orgId)}/experiments/${encodeURIComponent(legacy.experimentId)}/gates`);
    expect(viaEngine.status).toBe(200);
    expect((viaEngine.body as GateReport).gates.map((g) => [g.id, g.status])).toEqual((cms.body as GateReport).gates.map((g) => [g.id, g.status]));
    // Another org: the same 404 as a missing experiment.
    const other = (await call(jar, 'POST', '/host/openwop-app/orgs', { name: 'Other' })).body.orgId as string;
    expect((await call(jar, 'GET', `/host/openwop-app/experiments/orgs/${encodeURIComponent(other)}/experiments/${encodeURIComponent(legacy.experimentId)}/gates`)).status).toBe(404);
  });
});
