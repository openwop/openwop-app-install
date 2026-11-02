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
 *
 * TST-DEE-2 — red when: the iteration bound moves off the exact landing, a
 * satisfied final verdict loses to the bound, a replay increments, the
 * wall-clock pre-check is skipped (judge invoked), the cost flip moves, a negative
 * `costUsd` is accepted, or a re-bound run is counted twice. Same-run dedup is a
 * DOUBLE GUARD in `bindContributingRun`: the pre-lookup check (GL2CD-11) and the
 * in-CAS `ids.includes(runId)` re-check; either alone holds the claim, so the
 * witnessing probe breaks the shared state both read (the run id is never
 * recorded in `contributingRunIds`). The wall-clock leg fakes only `Date`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { buildRunRecord } from '../src/host/runDispatch.js';
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

interface ErrBody { error: string; message: string }

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text.length ? JSON.parse(text) : null) as T };
}

async function createGoalWith(bounds: Record<string, number>, verifierRef: string): Promise<string> {
  const { status, body } = await api<{ id: string }>('/host/openwop-app/goals', {
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
    `/host/openwop-app/goals/${id}/evaluate`,
    { method: 'POST', body: JSON.stringify({ snapshotRef: `ev:${hash}`, snapshotHash: hash }) },
  );


/** ADR 0908 D5 — a contributing run must be a real run of the goal's tenant. */
async function seedRun(tenantId: string, runId: string): Promise<void> {
  if (await hostExtStorage().getRun(runId)) return;
  await hostExtStorage().insertRun(buildRunRecord({ runId, workflowId: 'wf', tenantId }));
}

const bindRun = async (id: string, runId: string, costUsd?: number) => {
  const goal = await api<{ owner: { tenant: string } }>(`/host/openwop-app/goals/${encodeURIComponent(id)}`);
  await seedRun(goal.body.owner.tenant, runId);
  return api<{ state: string }>(`/host/openwop-app/goals/${id}/runs`, {
    method: 'POST',
    body: JSON.stringify({ runId, ...(costUsd !== undefined ? { costUsd } : {}) }),
  });
};

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
    expect(third.body).toMatchObject({ error: 'conflict', message: 'Goal is `bound-exceeded` — a judge may only evaluate an active goal.' });
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
    const { body } = await api<{ progress: { iterations: number } }>(`/host/openwop-app/goals/${id}`);
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
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-04-01T09:00:00.000Z'));
      const id = await createGoalWith({ runTimeoutMs: 5 }, 'vb:clock');
      vi.setSystemTime(new Date('2026-04-01T09:00:00.006Z')); // 6 ms > 5 ms bound
      const res = await api<ErrBody>(`/host/openwop-app/goals/${id}/evaluate`, { method: 'POST', body: JSON.stringify({ snapshotRef: 'ev:h1', snapshotHash: 'h1' }) });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'conflict', message: 'Goal bound exceeded (wallclock) — the goal is now `bound-exceeded`.' });
      expect(calls).toBe(0);
      const g = await api<{ state: string }>(`/host/openwop-app/goals/${id}`);
      expect(g.body.state).toBe('bound-exceeded');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cost bound', () => {
  it('contributing-run spend crossing maxCostUsd flips at bind time; same-run rebind never double-counts', async () => {
    registerGoalVerifier('vb:cost', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
    const id = await createGoalWith({ maxCostUsd: 2 }, 'vb:cost');

    // Cent-sensitive: a double-counted rebind (0.99 twice) crosses the cap one
    // bind early; a dropped cent on run:c leaves it under.
    expect((await bindRun(id, 'run:a', 0.99)).body.state).toBe('active');
    // Re-binding run:a is idempotent — its cost must count exactly once.
    expect((await bindRun(id, 'run:a', 0.99)).body.state).toBe('active');
    expect((await bindRun(id, 'run:b', 0.99)).body.state).toBe('active'); // 1.98 ≤ 2
    expect((await bindRun(id, 'run:c', 0.03)).body.state).toBe('bound-exceeded'); // 2.01 > 2
    const g = await api<{ progress: { contributingRunIds: string[] } }>(`/host/openwop-app/goals/${encodeURIComponent(id)}`);
    expect(g.body.progress.contributingRunIds).toEqual(['run:a', 'run:b', 'run:c']);
  });

  it('costUsd is validated (negative → 400)', async () => {
    registerGoalVerifier('vb:v', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
    const id = await createGoalWith({ maxCostUsd: 1 }, 'vb:v');
    const res = await bindRun(id, 'run:neg', -1);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'validation_error', message: 'Field `costUsd` must be a non-negative number.' });
  });
});
