/**
 * ADR 0983 — RFC 0251 eval baseline selection, the host half, over HTTP under
 * OpenWOP-Version 2 (nodes off, eval-fixture opt-in on: the prod posture).
 *
 * - D1: root `evalModes` / `baselineRunId` are accepted on an eval create and
 *   refused without `mode: "eval"`, outside the suite's modes, or apart from
 *   each other (a baseline without `regression`, `regression` without one).
 * - D3: every unusable baseline (unknown, another tenant's, another suite's)
 *   gets the SAME refusal, and none echoes the id.
 * - D4: on the conformance pair (`conformance-eval-regression-base` 1.0.0 and
 *   `-candidate` 1.1.0, one `suiteId`), `scoreDelta` is the aggregate
 *   difference (1/3) while pairing decides the verdict: 2 pairs, `unchanged`.
 * - D5/D6: `baselineSelection` is advertised; the regression fixtures are
 *   listed and `conformance-eval-gate-failing` is not (memory-isolation is
 *   listed since ADR 0989).
 *
 * Red when (sabotage-witnessed): `scoreDelta` is the paired-mean difference;
 * the baseline's suite is compared by `suiteRef`; a foreign baseline is
 * refused differently from an unknown one; the pairing rule is skipped.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'false';
  process.env.OPENWOP_CONFORMANCE_EVAL_FIXTURES = 'true';
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { CONFORMANCE_SUITE_PREFIX, SCRIPTED_AGENT_ID } from '../src/host/evals/fixtureSuites.js';
import { AGENT_SUITE_KIND } from '../src/host/evals/agentEvalRun.js';

const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const BASE_FX = 'conformance-eval-regression-base';
const CAND_FX = 'conformance-eval-regression-candidate';
const SUITE_ID = 'core.openwop.evals.conformance-eval-regression';
const ref = (id: string): string => `${CONFORMANCE_SUITE_PREFIX}${id}`;

let server: Server;
let base = '';
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  delete process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
  delete process.env.OPENWOP_CONFORMANCE_EVAL_FIXTURES;
  await new Promise<void>((r) => server.close(() => r()));
});

interface Reply { status: number; json: Record<string, unknown>; text: string }
async function send(method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${base}${path}`, { method, headers: V2, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted below */ }
  return { status: res.status, json, text };
}
async function waitTerminal(runId: string): Promise<string> {
  for (let i = 0; i < 400; i += 1) {
    const status = String(((await send('GET', `/runs/${runId}`)).json as { status?: string }).status ?? '');
    if (['completed', 'failed', 'cancelled'].includes(status)) return status;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} never settled`);
}
const create = (fixture: string, extra: Record<string, unknown>): Promise<Reply> =>
  send('POST', '/runs', { mode: 'eval', evalSuiteRef: ref(fixture), agentId: SCRIPTED_AGENT_ID, ...extra });
async function complete(fixture: string, extra: Record<string, unknown>): Promise<{ runId: string; summary: Record<string, unknown> }> {
  const c = await create(fixture, extra);
  expect(c.status, c.text.slice(0, 400)).toBe(201);
  const runId = String(c.json['runId']);
  expect(await waitTerminal(runId)).toBe('completed');
  const s = await send('GET', `/runs/${runId}/eval-summary`);
  expect(s.status, s.text.slice(0, 300)).toBe(200);
  return { runId, summary: s.json };
}
const reason = (r: Reply): unknown => (r.json['details'] as Record<string, unknown> | undefined)?.['reason'];
/** The v2 envelope carries the code as a string `error` (the conformance `readErrorCode` rule). */
const code = (r: Reply): unknown => (typeof r.json['error'] === 'string' ? r.json['error'] : (r.json['error'] as Record<string, unknown> | undefined)?.['code']);

let pair: Promise<{ baseRun: { runId: string; summary: Record<string, unknown> }; cand: { runId: string; summary: Record<string, unknown> } }> | undefined;
function runs() {
  pair ??= (async () => {
    const baseRun = await complete(BASE_FX, { evalModes: ['golden'] });
    const cand = await complete(CAND_FX, { evalModes: ['golden', 'regression'], baselineRunId: baseRun.runId });
    return { baseRun, cand };
  })();
  return pair;
}

describe('ADR 0983 D5/D6 — discovery', () => {
  it('advertises baselineSelection and lists the regression fixtures, not eval-gate-failing', async () => {
    const doc = await send('GET', '/.well-known/openwop');
    const facet = (doc.json['agents'] as Record<string, Record<string, unknown>>)['evalSuite']!;
    expect(facet['baselineSelection']).toBe(true);
    expect(facet['modes']).toContain('regression');
    const fixtures = doc.json['fixtures'] as string[];
    expect(fixtures).toEqual(expect.arrayContaining([BASE_FX, CAND_FX, 'conformance-eval-efficiency-ungated']));
    // ADR 0989 D5 lists memory-isolation (its tool now exists); eval-gate-failing
    // stays unlisted (ADR 0983 D6: no agents.deployment behind it).
    expect(fixtures).not.toContain('conformance-eval-gate-failing');
  });
});

describe('ADR 0983 D1/D4 — a client-named baseline', () => {
  it('echoes the baseline; scoreDelta is the aggregate difference; pairing decides the verdict', async () => {
    const { baseRun, cand } = await runs();
    expect(baseRun.summary['aggregateScore']).toBeCloseTo(2 / 3, 9);
    expect(cand.summary['aggregateScore']).toBe(1);
    const evs = (((await send('GET', `/runs/${cand.runId}/events/poll?limit=500`)).json as { events?: Array<{ type: string; payload: Record<string, unknown> }> }).events ?? []);
    const started = evs.filter((e) => e.type === 'eval.started');
    expect(started.map((e) => e.payload['baselineRunId'])).toEqual([baseRun.runId]);
    const reg = cand.summary['regression'] as Record<string, unknown>;
    expect(reg['baselineRunId']).toBe(baseRun.runId);
    expect(reg['scoreDelta'] as number).toBeCloseTo(1 / 3, 9);
    expect(reg).toMatchObject({ pairedTaskCount: 2, verdict: 'unchanged' });
  });
});

describe('ADR 0983 D1 — field rules', () => {
  it('refuses a baseline without regression, regression without a baseline, and modes outside the suite', async () => {
    const { baseRun } = await runs();
    const noMode = await create(CAND_FX, { evalModes: ['golden'], baselineRunId: baseRun.runId });
    expect([noMode.status, code(noMode), reason(noMode)]).toEqual([400, 'validation_error', 'baseline_without_regression']);
    const noBase = await create(CAND_FX, { evalModes: ['golden', 'regression'] });
    expect([noBase.status, code(noBase), reason(noBase)]).toEqual([400, 'validation_error', 'regression_without_baseline']);
    const rubric = await create(CAND_FX, { evalModes: ['rubric'] });
    expect([rubric.status, code(rubric)]).toEqual([400, 'validation_error']);
    for (const bad of [[], ['golden', 'golden'], 'golden']) {
      const r = await create(CAND_FX, { evalModes: bad });
      expect([r.status, code(r)], JSON.stringify(bad)).toEqual([400, 'validation_error']);
    }
  });

  it('refuses evalModes / baselineRunId on a create without mode "eval", before the workflow is resolved', async () => {
    // RFC 0251 §B: refused BEFORE the run starts. The v2 closed-root check runs only
    // once a workflow resolves, so an unknown workflow is what witnesses the
    // explicit check: without it this answers 404, not 400 validation_error.
    for (const workflowId of ['openwop-app.uppercase', 'no.such.workflow']) {
      for (const extra of [{ evalModes: ['golden'] }, { baselineRunId: 'x' }]) {
        const r = await send('POST', '/runs', { workflowId, inputs: {}, ...extra });
        expect([r.status, code(r)], `${workflowId} ${JSON.stringify(extra)}`).toEqual([400, 'validation_error']);
      }
    }
  });
});

describe('ADR 0983 D3 — one refusal for every unusable baseline', () => {
  it('an unknown id, another tenant\'s run and another suite\'s run are refused alike, never echoed', async () => {
    const { baseRun } = await runs();
    // Another tenant's completed run of the SAME suite (RFC 0251 §C: it would leak its aggregate).
    const now = new Date().toISOString();
    const foreign: RunRecord = {
      runId: `foreign-${Date.now()}`, workflowId: `eval:${ref(BASE_FX)}`, tenantId: 'tenant-b', status: 'completed', inputs: {},
      metadata: {
        mode: 'eval',
        eval: { kind: AGENT_SUITE_KIND, suiteRef: ref(BASE_FX), suiteSource: 'fixture', agentId: SCRIPTED_AGENT_ID },
        evalSummary: { suiteId: SUITE_ID, suiteVersion: '1.0.0', aggregateScore: 0.5, passed: false, taskCount: 3, passedCount: 1, totalCostUsd: 0, tasks: [] },
      },
      configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(foreign);
    const foreignWire = `tenant-b/${foreign.runId}`;
    const unknownWire = `${baseRun.runId.split('/')[0]}/0123456789abcdef0123456789abcdef`;
    const other = await complete('conformance-eval-trajectory', {});

    const answers = await Promise.all([unknownWire, foreignWire, foreign.runId, other.runId].map((id) =>
      create(CAND_FX, { evalModes: ['golden', 'regression'], baselineRunId: id }).then((r) => ({ id, r }))));
    const shape = (r: Reply) => ({ status: r.status, code: code(r), details: r.json['details'], message: r.json['message'] });
    for (const { id, r } of answers) {
      expect(shape(r), id).toEqual(shape(answers[0]!.r));
      expect(r.text, id).not.toContain(id.split('/').pop()!);
    }
    expect(shape(answers[0]!.r)).toEqual({ status: 400, code: 'validation_error', details: { field: 'baselineRunId', reason: 'baseline_unusable' }, message: 'The baseline run cannot be used.' });
  });
});
