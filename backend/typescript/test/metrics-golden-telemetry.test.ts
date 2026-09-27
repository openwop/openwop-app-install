/**
 * ADR 0556 P1 — golden telemetry for success, failure, retry, replay and
 * recovery (the phase gate, verbatim).
 *
 * WHAT MAKES THESE GOLDEN RATHER THAN DECORATIVE. Each path is driven through
 * the REAL seam — a booted app, an HTTP request, a real `:fork`, the real
 * storage claim — and then asserts the EXACT attribute set the exporter would
 * see. Three failure modes this shape is built to catch, all of which a
 * "counter went up" assertion passes straight through:
 *
 *   1. the metric is emitted from a helper the seam never calls (deleting the
 *      call site leaves the test green);
 *   2. the attributes are right in the call and wrong after the cardinality
 *      guard (a label the catalog does not declare is DROPPED, silently);
 *   3. a label carries an unbounded value — `status: '500'` instead of
 *      `status_class: '5xx'`, `route: '/v1/runs/019a…'` instead of the
 *      template. Nothing fails; the collector falls over next quarter.
 *
 * So assertions are `toEqual` on the whole attribute object, never
 * `toMatchObject`, and the emission ledger is read rather than a mock.
 *
 * The ledger only records when a test arms it (`_resetMetricsForTest`), so in
 * production `emissions` stays `null` and the instrumentation costs one null
 * check. An unarmed ledger reads as empty — which is why every assertion here
 * expects a NON-empty result and would fail rather than pass vacuously.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { assertEffectAllowed, __resetEffectCountsForTest } from '../src/host/runEffectContext.js';
import {
  _resetMetricsForTest,
  emissionsOf,
  labelViolations,
  type MetricEmission,
} from '../src/observability/metrics.js';
import { _resetRunStartsForTest } from '../src/observability/metricSeams.js';
import { canonicalRequestDigest } from '../src/host/idempotentResponse.js';
import type { Storage } from '../src/storage/storage.js';

let app: Express;
let server: http.Server;
let BASE: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });

  getNodeRegistry().register({
    typeId: 'test.metrics.ok',
    version: '1.0.0',
    async execute() {
      return { status: 'success', outputs: { output: 'ok' } };
    },
  });

  getNodeRegistry().register({
    typeId: 'test.metrics.boom',
    version: '1.0.0',
    async execute() {
      throw new Error('deliberate node failure');
    },
  });

  // UNCLASSIFIED (no `sideEffecting`, typeId matches nothing in
  // `sideEffects.ts`), so the ADR 0341 fast path never short-circuits it and a
  // replay reaches the ADR 0531 backstop — which is the seam under test.
  getNodeRegistry().register({
    typeId: 'test.metrics.effect',
    version: '1.0.0',
    async execute() {
      assertEffectAllowed('email', 'golden-telemetry probe');
      return { status: 'success', outputs: { output: 'sent' } };
    },
  });

  // CLASSIFIED and FAILING: the source run records a failure, and the replay is
  // served that failure rather than re-running the effect to fail again.
  getNodeRegistry().register({
    typeId: 'test.metrics.classifiedBoom',
    version: '1.0.0',
    sideEffecting: true,
    async execute() {
      throw new Error('deliberate side-effecting failure');
    },
  });

  // CLASSIFIED side-effecting: a replay is served the source run's recorded
  // outcome and the node never executes.
  getNodeRegistry().register({
    typeId: 'test.metrics.classified',
    version: '1.0.0',
    sideEffecting: true,
    async execute() {
      return { status: 'success', outputs: { output: 'committed' } };
    },
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(() => {
  _resetMetricsForTest();
  _resetRunStartsForTest();
  __resetEffectCountsForTest();
});

async function api<T = Record<string, unknown>>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function settle(runId: string): Promise<string> {
  let status = 'pending';
  for (let i = 0; i < 160; i++) {
    await new Promise((r) => setTimeout(r, 25));
    status = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
    if (['completed', 'failed', 'cancelled', 'awaiting-input'].includes(status)) break;
  }
  return status;
}

async function defineWorkflow(workflowId: string, typeId: string): Promise<void> {
  const res = await api('/v1/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'n1', typeId }], edges: [] }),
  });
  expect([200, 201]).toContain(res.status);
}

async function startRun(workflowId: string, headers: Record<string, string> = {}) {
  return api<{ runId: string }>('/v1/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }),
  });
}

/** The attribute bags recorded for `name`, in order. */
function attrsOf(name: string): Array<Record<string, unknown>> {
  return emissionsOf(name).map((e: MetricEmission) => ({ ...e.attributes }));
}

describe('ADR 0556 P1 — SUCCESS: a run that completes', () => {
  it('emits start, terminal and duration with the exact catalog label sets', async () => {
    await defineWorkflow('adr0556.ok', 'test.metrics.ok');
    const created = await startRun('adr0556.ok');
    expect(created.status).toBe(201);
    expect(await settle(created.body.runId)).toBe('completed');

    // `builtin` because the definition carries no chain stamp; `api` because
    // this run came from POST /v1/runs and not a scheduler or a kanban card.
    expect(attrsOf('openwop.run.started')).toEqual([{ workflow_kind: 'builtin', trigger: 'api' }]);
    expect(attrsOf('openwop.run.completed')).toEqual([{ workflow_kind: 'builtin', status: 'completed' }]);

    const durations = emissionsOf('openwop.run.duration');
    expect(durations).toHaveLength(1);
    expect(durations[0]!.attributes).toEqual({ workflow_kind: 'builtin', status: 'completed' });
    // In SECONDS, not milliseconds — the catalog declares `unit: 's'` and its
    // buckets are seconds. A millisecond value would land in the top bucket for
    // every run and the histogram would report a permanently broken SLO.
    expect(durations[0]!.value).toBeGreaterThanOrEqual(0);
    expect(durations[0]!.value).toBeLessThan(60);

    expect(attrsOf('openwop.node.duration')).toEqual([{ status: 'success', replayed: false }]);
  });

  it('records HTTP latency by ROUTE TEMPLATE, never the resolved path', async () => {
    await defineWorkflow('adr0556.http', 'test.metrics.ok');
    const created = await startRun('adr0556.http');
    await settle(created.body.runId);

    const http2xx = attrsOf('openwop.http.server.duration');
    // `stream: false` joined this bag in ADR 0556 P2. It is a bounded two-value
    // label set from the rate limiter's own `isLongLivedSseStream(req)`, and it
    // exists so the latency objectives can exclude EventStream connections —
    // whose duration is a browser tab's lifetime, not a request latency —
    // without a second list of which routes are streams. This assertion
    // deliberately stays EXACT rather than becoming a partial match: it is the
    // test that would notice an unbounded label being added here, which is the
    // failure this whole metric family is guarded against.
    expect(http2xx).toContainEqual({ route: '/v1/runs', method: 'POST', status_class: '2xx', stream: false });

    // THE assertion that matters. `GET /v1/runs/:runId` is one series; the
    // resolved path is one series PER RUN. Every recorded route must be a
    // template — no emission may contain the run id we just minted.
    const routes = http2xx.map((a) => String(a.route));
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route).not.toContain(created.body.runId);
    }
    expect(routes).toContain('/v1/runs/:runId');
  });
});

describe('ADR 0556 P1 — FAILURE: a run whose node throws', () => {
  it('emits a failed terminal and a failed step, distinguishable from success', async () => {
    await defineWorkflow('adr0556.boom', 'test.metrics.boom');
    const created = await startRun('adr0556.boom');
    expect(created.status).toBe(201);
    expect(await settle(created.body.runId)).toBe('failed');

    expect(attrsOf('openwop.run.completed')).toEqual([{ workflow_kind: 'builtin', status: 'failed' }]);
    expect(emissionsOf('openwop.run.duration')[0]!.attributes).toEqual({
      workflow_kind: 'builtin',
      status: 'failed',
    });
    // A failed node still produces a latency observation. Dropping it would
    // make the p99 describe only the requests that worked, which is the number
    // an incident is least interested in.
    expect(attrsOf('openwop.node.duration')).toEqual([{ status: 'failure', replayed: false }]);
  });
});

describe('ADR 0556 P1 — RETRY: the same Idempotency-Key twice', () => {
  it('counts the first claim and the replay separately, on a bounded endpoint label', async () => {
    await defineWorkflow('adr0556.retry', 'test.metrics.ok');
    const key = `golden-retry-${Date.now()}`;
    const first = await startRun('adr0556.retry', { 'idempotency-key': key });
    expect(first.status).toBe(201);
    await settle(first.body.runId);

    const retry = await startRun('adr0556.retry', { 'idempotency-key': key });
    expect(retry.status).toBe(201);

    expect(attrsOf('openwop.idempotency.claim')).toEqual([
      { endpoint: 'POST:/v1/runs', outcome: 'claimed' },
      { endpoint: 'POST:/v1/runs', outcome: 'replay' },
    ]);
    // The key itself must never appear anywhere in the telemetry: it is
    // caller-supplied and routinely carries customer identifiers (ADR 0549 P2
    // log hygiene). This is the assertion that would have caught it.
    expect(JSON.stringify(emissionsOf('openwop.idempotency.claim'))).not.toContain(key);
  });
});

describe('ADR 0556 P1 — REPLAY: a fork re-executing history', () => {
  it('the probe node is UNCLASSIFIED — if this fails, the blocked test below proves nothing', () => {
    // Were it classified, ADR 0341 would serve its recorded outcome and the
    // backstop would never be reached. Pinned so a broadened allowlist fails
    // HERE rather than turning the next test into a tautology.
    expect(isSideEffectingNode('test.metrics.effect')).toBe(false);
    expect(isSideEffectingNode('test.metrics.classified', { sideEffecting: true })).toBe(true);
  });

  it('an allowed effect counts as dispatched; the replay of the same effect counts as BLOCKED', async () => {
    await defineWorkflow('adr0556.effect', 'test.metrics.effect');
    const live = await startRun('adr0556.effect');
    expect(await settle(live.body.runId)).toBe('completed');
    expect(attrsOf('openwop.effect.dispatched')).toEqual([{ effect_kind: 'email', outcome: 'allowed' }]);
    expect(emissionsOf('openwop.effect.blocked')).toHaveLength(0);

    _resetMetricsForTest();
    const fork = await api<{ runId: string }>(`/v1/runs/${live.body.runId}:fork`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'replay' }),
    });
    expect(fork.status).toBe(201);
    expect(await settle(fork.body.runId)).toBe('failed');

    // The counter this ADR was written around: `runEffectContext.ts` carried a
    // comment saying a metrics pipeline did not exist, and fell back to a log.
    expect(attrsOf('openwop.effect.blocked')).toEqual([{ effect_kind: 'email' }]);
    // Separate metrics, not one with an `outcome` label: nothing was dispatched.
    expect(emissionsOf('openwop.effect.dispatched')).toHaveLength(0);
  });

  it('a recorded FAILURE is served as a failure, not re-attempted and not counted as success', async () => {
    await defineWorkflow('adr0556.classified-boom', 'test.metrics.classifiedBoom');
    const live = await startRun('adr0556.classified-boom');
    expect(await settle(live.body.runId)).toBe('failed');

    _resetMetricsForTest();
    const fork = await api<{ runId: string }>(`/v1/runs/${live.body.runId}:fork`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'replay' }),
    });
    expect(fork.status).toBe(201);
    expect(await settle(fork.body.runId)).toBe('failed');

    // `recorded-failure` is ordinary replay traffic; only `source-missing` is
    // the fail-closed arm worth alerting on. Folding the two would make the
    // alertable signal unreadable in a system that replays failures routinely.
    expect(attrsOf('openwop.replay.node.served')).toEqual([{ outcome: 'recorded-failure' }]);
    expect(attrsOf('openwop.node.duration')).toEqual([{ status: 'failure', replayed: true }]);
  });

  it('a CLASSIFIED side-effecting node is served from the source and marked replayed', async () => {
    await defineWorkflow('adr0556.classified', 'test.metrics.classified');
    const live = await startRun('adr0556.classified');
    expect(await settle(live.body.runId)).toBe('completed');
    expect(emissionsOf('openwop.replay.node.served')).toHaveLength(0); // a live run serves nothing

    _resetMetricsForTest();
    const fork = await api<{ runId: string }>(`/v1/runs/${live.body.runId}:fork`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'replay' }),
    });
    expect(fork.status).toBe(201);
    expect(await settle(fork.body.runId)).toBe('completed');

    expect(attrsOf('openwop.replay.node.served')).toEqual([{ outcome: 'recorded-success' }]);
    // `replayed: true` separates re-execution latency from live traffic. Mixing
    // them makes a p99 describe a population that does not exist.
    expect(attrsOf('openwop.node.duration')).toEqual([{ status: 'success', replayed: true }]);
    // No effect left the host on the fork, so nothing was dispatched.
    expect(emissionsOf('openwop.effect.dispatched')).toHaveLength(0);
  });
});

describe('ADR 0556 P1 — RECOVERY: a dead holder is reclaimed', () => {
  it('a reclaimed claim is counted as `reclaimed`, not as an ordinary first claim', async () => {
    await defineWorkflow('adr0556.recover', 'test.metrics.ok');
    const storage = app.locals.storage as Storage;

    // Discover the AUTHORIZED tenant rather than assuming one: the route keys
    // the claim on the principal's tenant, and a guessed value would seed a row
    // the route never looks at — the test would then pass by measuring a first
    // claim and calling it recovery.
    const probe = await startRun('adr0556.recover');
    await settle(probe.body.runId);
    const tenantId = (await storage.getRun(probe.body.runId))!.tenantId;

    const key = `golden-recover-${Date.now()}`;
    const body = { workflowId: 'adr0556.recover', inputs: {}, tenantId: '_anon' };
    // A claim that is ALREADY expired: a zero lease means `claim_expires_at`
    // equals a `createdAt` in the past, so the next claim sees a dead holder.
    const seeded = await storage.claimIdempotentResponse({
      tenantId,
      endpoint: 'POST:/v1/runs',
      key,
      requestDigest: canonicalRequestDigest(body, 'POST:/v1/runs'),
      createdAt: new Date(Date.now() - 600_000).toISOString(),
      leaseMs: 0,
    });
    expect(seeded.outcome).toBe('claimed');
    expect(seeded.outcome === 'claimed' && seeded.reclaimed).toBeUndefined(); // a FIRST claim

    _resetMetricsForTest();
    const recovered = await api<{ runId: string }>('/v1/runs', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    expect(recovered.status).toBe(201);

    expect(attrsOf('openwop.idempotency.claim')).toEqual([
      { endpoint: 'POST:/v1/runs', outcome: 'reclaimed' },
    ]);
  });

  it('a run whose START this process never saw reports `unknown` and NO duration', async () => {
    // The honest branch. `notifyRunTerminal` is given an id and a status; the
    // workflow kind and the start instant come from an in-process registry a
    // cold start wipes. Fabricating a duration from `run.createdAt` would time
    // the queue wait as well as the run, and fabricating a kind would be a
    // guess an operator cannot tell apart from a measurement.
    const { notifyRunTerminal } = await import('../src/executor/runLifecycle.js');
    notifyRunTerminal('run-this-process-never-started', 'failed');

    expect(attrsOf('openwop.run.completed')).toEqual([{ workflow_kind: 'unknown', status: 'failed' }]);
    expect(emissionsOf('openwop.run.duration')).toHaveLength(0);
  });
});

describe('ADR 0556 P1 — the guard is wired into the live seams', () => {
  it('no emission from any seam carried a forbidden or undeclared label', async () => {
    await defineWorkflow('adr0556.clean', 'test.metrics.ok');
    const created = await startRun('adr0556.clean');
    expect(await settle(created.body.runId)).toBe('completed');

    // A violation here would mean a seam passed the guard something it dropped
    // — i.e. the metric shipped with a dimension silently missing. The ledger
    // is positive evidence, unlike "the label is absent from the output", which
    // would also hold if the guard dropped everything.
    expect([...labelViolations().entries()]).toEqual([]);
    // …and the run genuinely produced telemetry, so the empty ledger above is
    // an absence of violations rather than an absence of emissions.
    expect(emissionsOf('openwop.run.completed').length).toBeGreaterThan(0);
  });
});
