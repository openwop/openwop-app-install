/**
 * Standing goals (RFC 0097) — host-sample seam + invariants.
 *
 * Covers the `goal-standing-continuation` behavioral legs:
 *   - create without RFC 0058 bounds → 422 (requiresBounds advertised)
 *   - a client-supplied `state: satisfied` (POST /goals/{id}) → 4xx
 *     (`goal-completion-judge-only`)
 * plus a happy-path bounded create and the lifecycle transitions.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_GOALS_ENABLED = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text.length ? JSON.parse(text) : null) as T };
}

describe('goals — standing-continuation seam (RFC 0097)', () => {
  it('GET /goals seeds a non-vacuous demo active goal', async () => {
    const { status, body } = await api<{ goals: Array<{ id: string; state: string }> }>(
      '/v1/host/openwop-app/goals?state=active',
    );
    expect(status).toBe(200);
    expect(body.goals.length).toBeGreaterThan(0);
    expect(body.goals.every((g) => g.state === 'active')).toBe(true);
  });

  it('create without bounds is rejected 422 (goal-continuation-bounded)', async () => {
    const res = await api('/v1/host/openwop-app/goals', {
      method: 'POST',
      body: JSON.stringify({ objective: 'unbounded work', completion: { check: 'host' }, continuation: { mode: 'manual' } }),
    });
    expect(res.status).toBe(422);
  });

  it('create WITH bounds succeeds and is active', async () => {
    const res = await api<{ id: string; state: string; bounds: unknown }>('/v1/host/openwop-app/goals', {
      method: 'POST',
      body: JSON.stringify({
        objective: 'bounded work',
        completion: { check: 'verifier' },
        continuation: { mode: 'schedule' },
        bounds: { maxLoopIterations: 5 },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('active');
  });

  it('a client MUST NOT set state: satisfied (POST /goals/{id} → 4xx)', async () => {
    const list = await api<{ goals: Array<{ id: string }> }>('/v1/host/openwop-app/goals?state=active');
    const id = list.body.goals[0]!.id;
    const res = await api(`/v1/host/openwop-app/goals/${id}`, { method: 'POST', body: JSON.stringify({ state: 'satisfied' }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(404); // routed — the leg is non-vacuous
    // Still active — the verdict was refused.
    const after = await api<{ state: string }>(`/v1/host/openwop-app/goals/${id}`);
    expect(after.body.state).toBe('active');
  });

  it('client lifecycle: abandon transitions to abandoned (not a judge verdict)', async () => {
    const created = await api<{ id: string }>('/v1/host/openwop-app/goals', {
      method: 'POST',
      body: JSON.stringify({ objective: 'to abandon', completion: { check: 'verifier' }, continuation: { mode: 'manual' }, bounds: { runTimeoutMs: 1000 } }),
    });
    const res = await api<{ state: string }>(`/v1/host/openwop-app/goals/${created.body.id}/abandon`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('abandoned');
  });
});
