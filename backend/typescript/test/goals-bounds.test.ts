/**
 * ADR 0412 P2 — runtime RFC 0058 bound enforcement.
 *
 * Exact-bound termination legs:
 *  - iterations: an unsatisfied verdict LANDING on `maxLoopIterations` flips to
 *    `bound-exceeded`; a satisfied verdict on the final allowed iteration wins.
 *  - wall-clock: `runTimeoutMs` past `createdAt` → `bound-exceeded` WITHOUT
 *    invoking the judge (fail-closed on spend).
 *  - cost: contributing-run spend crossing `maxCostUsd` at bind time flips the
 *    goal; re-binding the same run never double-counts.
 *  - replayed evaluations never increment iterations or flip state.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { registerGoalVerifier, __clearGoalVerifiers } from '../src/features/goals/goalVerifiers.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({
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
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

afterEach(() => __clearGoalVerifiers());

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text.length ? JSON.parse(text) : null) as T };
}

async function createGoalWith(bounds: Record<string, number>, verifierRef: string): Promise<string> {
  const { status, body } = await api<{ id: string }>('/v1/host/openwop-app/goals', {
    method: 'POST',
    body: JSON.stringify({
      objective: 'Bounded objective',
      completion: { check: 'verifier', verifierRef },
      continuation: { mode: 'manual' },
      bounds,
    }),
  });
  expect(status).toBe(200);
  return body.id;
}

const evaluate = (id: string, hash: string) =>
  api<{ goal: { state: string; progress: { iterations: number } }; replayed: boolean }>(
    `/v1/host/openwop-app/goals/${id}/evaluate`,
    { method: 'POST', body: JSON.stringify({ snapshotRef: `ev:${hash}`, snapshotHash: hash }) },
  );

const bindRun = (id: string, runId: string, costUsd?: number) =>
  api<{ state: string }>(`/v1/host/openwop-app/goals/${id}/runs`, {
    method: 'POST',
    body: JSON.stringify({ runId, ...(costUsd !== undefined ? { costUsd } : {}) }),
  });

describe('iterations bound', () => {
  it('unsatisfied verdict landing on maxLoopIterations flips to bound-exceeded', async () => {
    let calls = 0;
    registerGoalVerifier('vb:unsat', async () => {
      calls++;
      return { satisfied: false, confidence: 0.2, runId: `run-${calls}` };
    });
    const id = await createGoalWith({ maxLoopIterations: 2 }, 'vb:unsat');

    const first = await evaluate(id, 'h1');
    expect(first.body.goal.state).toBe('active');
    expect(first.body.goal.progress.iterations).toBe(1);

    const second = await evaluate(id, 'h2');
    expect(second.body.goal.state).toBe('bound-exceeded');
    expect(second.body.goal.progress.iterations).toBe(2);

    // Terminal now — a further evaluation is refused, judge not re-invoked.
    const third = await evaluate(id, 'h3');
    expect(third.status).toBe(409);
    expect(calls).toBe(2);
  });

  it('satisfied verdict on the final allowed iteration wins over the bound', async () => {
    registerGoalVerifier('vb:sat', async () => ({ satisfied: true, confidence: 1, runId: 'run-s' }));
    const id = await createGoalWith({ maxLoopIterations: 1 }, 'vb:sat');
    const { body } = await evaluate(id, 'h1');
    expect(body.goal.state).toBe('satisfied');
  });

  it('replayed evaluation does not increment iterations', async () => {
    registerGoalVerifier('vb:replay', async () => ({ satisfied: false, confidence: 0.5, runId: 'run-r' }));
    const id = await createGoalWith({ maxLoopIterations: 3 }, 'vb:replay');
    await evaluate(id, 'same');
    const replayed = await evaluate(id, 'same');
    expect(replayed.body.replayed).toBe(true);
    const { body } = await api<{ progress: { iterations: number } }>(`/v1/host/openwop-app/goals/${id}`);
    expect(body.progress.iterations).toBe(1);
  });
});

describe('wall-clock bound', () => {
  it('runTimeoutMs past createdAt → bound-exceeded WITHOUT invoking the judge', async () => {
    let calls = 0;
    registerGoalVerifier('vb:clock', async () => {
      calls++;
      return { satisfied: true, confidence: 1, runId: 'run-c' };
    });
    const id = await createGoalWith({ runTimeoutMs: 5 }, 'vb:clock');
    await new Promise((r) => setTimeout(r, 25));
    const { status } = await evaluate(id, 'h1');
    expect(status).toBe(409);
    expect(calls).toBe(0);
    const g = await api<{ state: string }>(`/v1/host/openwop-app/goals/${id}`);
    expect(g.body.state).toBe('bound-exceeded');
  });
});

describe('cost bound', () => {
  it('contributing-run spend crossing maxCostUsd flips at bind time; same-run rebind never double-counts', async () => {
    registerGoalVerifier('vb:cost', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
    const id = await createGoalWith({ maxCostUsd: 2 }, 'vb:cost');

    expect((await bindRun(id, 'run:a', 0.9)).body.state).toBe('active');
    // Re-binding run:a is idempotent — its cost must count exactly once.
    expect((await bindRun(id, 'run:a', 0.9)).body.state).toBe('active');
    expect((await bindRun(id, 'run:b', 0.9)).body.state).toBe('active'); // 1.8 ≤ 2
    expect((await bindRun(id, 'run:c', 0.3)).body.state).toBe('bound-exceeded'); // 2.1 > 2
  });

  it('costUsd is validated (negative → 400)', async () => {
    registerGoalVerifier('vb:v', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
    const id = await createGoalWith({ maxCostUsd: 1 }, 'vb:v');
    const { status } = await bindRun(id, 'run:neg', -1);
    expect(status).toBe(400);
  });
});
