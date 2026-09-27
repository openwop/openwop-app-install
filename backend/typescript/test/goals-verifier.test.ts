/**
 * ADR 0412 P1 — run-binding + verifier invocation (the judge-write path).
 *
 * Covers: convergence transitions (satisfied / stay-active / escalated),
 * replay idempotency (same evidence snapshot → recorded verdict, verifier NOT
 * re-invoked), fail-closed judge errors (missing → 409, throwing/malformed →
 * 502, state untouched), contributing-run dedup binding, cross-tenant denial
 * (service-level, the adr0379 pattern), and the wire projection (host-private
 * sidecar state never leaves the service).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { registerGoalVerifier, __clearGoalVerifiers } from '../src/features/goals/goalVerifiers.js';
import {
  bindContributingRun,
  createGoal,
  evaluateGoal,
  getGoal,
} from '../src/features/goals/goalsService.js';

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

const BOUNDS = { maxLoopIterations: 5, runTimeoutMs: 60_000 };

async function createRouteGoal(verifierRef: string): Promise<string> {
  const { status, body } = await api<{ id: string }>('/v1/host/openwop-app/goals', {
    method: 'POST',
    body: JSON.stringify({
      objective: 'Reach the declared outcome',
      completion: { check: 'verifier', verifierRef },
      continuation: { mode: 'manual' },
      bounds: BOUNDS,
    }),
  });
  expect(status).toBe(200);
  return body.id;
}

describe('evaluate — convergence transitions (route)', () => {
  it('satisfied verdict → terminal `satisfied`, lastVerdict persisted', async () => {
    registerGoalVerifier('v:pass', async () => ({ satisfied: true, confidence: 0.9, runId: 'run-1' }));
    const id = await createRouteGoal('v:pass');
    const { status, body } = await api<{ goal: { state: string; completion: { lastVerdict: unknown } }; verdict: { satisfied: boolean }; replayed: boolean }>(
      `/v1/host/openwop-app/goals/${id}/evaluate`,
      { method: 'POST', body: JSON.stringify({ snapshotRef: 'ev:1', snapshotHash: 'h1' }) },
    );
    expect(status).toBe(200);
    expect(body.goal.state).toBe('satisfied');
    expect(body.verdict.satisfied).toBe(true);
    expect(body.replayed).toBe(false);
    expect(body.goal.completion.lastVerdict).toEqual({ satisfied: true, confidence: 0.9, runId: 'run-1' });
  });

  it('unsatisfied (no escalate) → goal stays active with the verdict recorded', async () => {
    registerGoalVerifier('v:not-yet', async () => ({ satisfied: false, confidence: 0.4, runId: 'run-2' }));
    const id = await createRouteGoal('v:not-yet');
    const { status, body } = await api<{ goal: { state: string } }>(`/v1/host/openwop-app/goals/${id}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ snapshotRef: 'ev:2', snapshotHash: 'h2' }),
    });
    expect(status).toBe(200);
    expect(body.goal.state).toBe('active');
  });

  it('escalate verdict → terminal `escalated`', async () => {
    registerGoalVerifier('v:escalate', async () => ({ satisfied: false, confidence: 0.8, runId: 'run-3', escalate: true }));
    const id = await createRouteGoal('v:escalate');
    const { body } = await api<{ goal: { state: string } }>(`/v1/host/openwop-app/goals/${id}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ snapshotRef: 'ev:3', snapshotHash: 'h3' }),
    });
    expect(body.goal.state).toBe('escalated');
  });
});

describe('evaluate — replay idempotency', () => {
  it('same snapshotHash re-evaluation returns the recorded verdict WITHOUT re-invoking the verifier', async () => {
    let calls = 0;
    registerGoalVerifier('v:count', async () => {
      calls++;
      return { satisfied: true, confidence: 1, runId: 'run-4' };
    });
    const id = await createRouteGoal('v:count');
    const first = await api<{ replayed: boolean }>(`/v1/host/openwop-app/goals/${id}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ snapshotRef: 'ev:4', snapshotHash: 'h4' }),
    });
    const second = await api<{ replayed: boolean; verdict: { runId: string } }>(`/v1/host/openwop-app/goals/${id}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ snapshotRef: 'ev:4', snapshotHash: 'h4' }),
    });
    expect(first.body.replayed).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.verdict.runId).toBe('run-4');
    expect(calls).toBe(1);
  });

  it('NEW evidence against a terminal goal → 409 (no re-judging a closed goal)', async () => {
    registerGoalVerifier('v:done', async () => ({ satisfied: true, confidence: 1, runId: 'run-5' }));
    const id = await createRouteGoal('v:done');
    await api(`/v1/host/openwop-app/goals/${id}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ snapshotRef: 'ev:5', snapshotHash: 'h5' }),
    });
    const { status } = await api(`/v1/host/openwop-app/goals/${id}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ snapshotRef: 'ev:6', snapshotHash: 'h6' }),
    });
    expect(status).toBe(409);
  });
});

describe('evaluate — fail-closed judge errors', () => {
  it('unregistered verifierRef → 409, goal untouched', async () => {
    const id = await createRouteGoal('v:nobody-home');
    const { status } = await api(`/v1/host/openwop-app/goals/${id}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ snapshotRef: 'ev:7', snapshotHash: 'h7' }),
    });
    expect(status).toBe(409);
    const g = await api<{ state: string; completion: { lastVerdict?: unknown } }>(`/v1/host/openwop-app/goals/${id}`);
    expect(g.body.state).toBe('active');
    expect(g.body.completion.lastVerdict).toBeUndefined();
  });

  it('throwing verifier → 502, goal untouched (never completes)', async () => {
    registerGoalVerifier('v:boom', async () => {
      throw new Error('provider down');
    });
    const id = await createRouteGoal('v:boom');
    const { status } = await api(`/v1/host/openwop-app/goals/${id}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ snapshotRef: 'ev:8', snapshotHash: 'h8' }),
    });
    expect(status).toBe(502);
    const g = await api<{ state: string }>(`/v1/host/openwop-app/goals/${id}`);
    expect(g.body.state).toBe('active');
  });

  it('malformed verdict (typed failure, never success-with-empty) → 502', async () => {
    registerGoalVerifier('v:garbage', async () => ({ satisfied: 'yes' } as never));
    const id = await createRouteGoal('v:garbage');
    const { status } = await api(`/v1/host/openwop-app/goals/${id}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ snapshotRef: 'ev:9', snapshotHash: 'h9' }),
    });
    expect(status).toBe(502);
  });
});

describe('contributing-run binding', () => {
  it('POST /goals/:id/runs appends once (dedup) and is visible in progress', async () => {
    registerGoalVerifier('v:x', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
    const id = await createRouteGoal('v:x');
    for (let i = 0; i < 2; i++) {
      const { status } = await api(`/v1/host/openwop-app/goals/${id}/runs`, {
        method: 'POST',
        body: JSON.stringify({ runId: 'run:contrib-1' }),
      });
      expect(status).toBe(200);
    }
    const { body } = await api<{ progress: { contributingRunIds: string[] } }>(`/v1/host/openwop-app/goals/${id}`);
    expect(body.progress.contributingRunIds).toEqual(['run:contrib-1']);
  });

  it('missing runId → 400; unknown goal → 404', async () => {
    const bad = await api('/v1/host/openwop-app/goals/nope/runs', { method: 'POST', body: JSON.stringify({}) });
    expect(bad.status).toBe(400);
    const missing = await api('/v1/host/openwop-app/goals/nope/runs', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run:x' }),
    });
    expect(missing.status).toBe(404);
  });
});

describe('cross-tenant denial (service-level, adr0379 pattern)', () => {
  it('another tenant cannot see, bind, or evaluate a foreign goal', async () => {
    registerGoalVerifier('v:t', async () => ({ satisfied: true, confidence: 1, runId: 'r' }));
    const goal = await createGoal({
      objective: 'tenant-a private goal',
      completion: { check: 'verifier', verifierRef: 'v:t' },
      continuation: { mode: 'manual' },
      bounds: BOUNDS,
      owner: { tenant: 'tenant-a' },
    });
    expect(await getGoal('tenant-b', goal.id)).toBeNull();
    expect(await bindContributingRun('tenant-b', goal.id, 'run:evil')).toBeNull();
    expect(await evaluateGoal('tenant-b', goal.id, { snapshotRef: 'e', snapshotHash: 'h' })).toBeNull();
    // And the owner still can:
    const mine = await evaluateGoal('tenant-a', goal.id, { snapshotRef: 'e', snapshotHash: 'h' });
    expect(mine?.goal.state).toBe('satisfied');
  });
});

describe('wire projection', () => {
  it('host-private evidence sidecar never appears on wire/service output', async () => {
    registerGoalVerifier('v:wire', async () => ({ satisfied: true, confidence: 1, runId: 'run-w' }));
    const id = await createRouteGoal('v:wire');
    const { body } = await api<Record<string, unknown>>(`/v1/host/openwop-app/goals/${id}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ snapshotRef: 'ev:w', snapshotHash: 'hw' }),
    });
    expect((body.goal as Record<string, unknown>).host).toBeUndefined();
    const got = await api<Record<string, unknown>>(`/v1/host/openwop-app/goals/${id}`);
    expect(got.body.host).toBeUndefined();
    const listed = await api<{ goals: Record<string, unknown>[] }>('/v1/host/openwop-app/goals');
    expect(listed.body.goals.every((g) => g.host === undefined)).toBe(true);
  });
});
