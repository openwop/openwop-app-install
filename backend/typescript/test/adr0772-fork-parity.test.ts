/**
 * ADR 0772 D3 — `:fork` is run creation. Route-level, against the real app:
 *
 *  - `RRWF-6`: the fork route carries the run quota `POST /v1/runs` does.
 *  - `RRWF-7`: a prefix copy that fails part-way leaves a FAILED fork (never a
 *    `pending` one the orphan sweeper would run on a partial log), and the 500
 *    names it.
 *  - `RRWF-9`: cancelling a source never cancels its forks.
 *
 * Red when (wave 60 probes, tracker TST-BRB-5): the fork route loses
 * `runQuotaMiddleware`; a refused fork is charged; the copy failure stops failing the
 * row before answering (both writes below), or stops naming the fork in `Location`;
 * the cancel cascade stops excluding `forkMode` rows.
 *
 * Double guard, recorded: RRWF-7's failed row is written by `storage.updateRun`
 * AND by `emitTerminalFailure` (`routes/runs.ts`). Dropping either alone stays green;
 * skipping both reds it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { _resetRateLimitState } from '../src/middleware/rateLimit.js';
import type { Storage } from '../src/storage/storage.js';
import { bareRunId } from './support/bareRunId.js';

let server: http.Server;
let BASE = '';
let storage: Storage;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };
const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_RATELIMIT_DISABLED', 'OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN', 'OPENWOP_RATELIMIT_IP_RUNS_PER_DAY'] as const;
const SAVED = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  for (const k of ENV_KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(() => {
  delete process.env.OPENWOP_RATELIMIT_DISABLED;
  delete process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN;
  delete process.env.OPENWOP_RATELIMIT_IP_RUNS_PER_DAY;
  _resetRateLimitState();
});

type Json = Record<string, unknown>;
async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T; location: string | null }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T, location: res.headers.get('location') };
}
async function waitStatus(runId: string, pred: (s: string) => boolean): Promise<string> {
  let status = '';
  for (let i = 0; i < 300; i++) {
    status = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
    if (pred(status)) return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return status;
}
async function completedRun(): Promise<string> {
  const r = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'conformance-multi-node' }) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(await waitStatus(r.body.runId, (s) => ['completed', 'failed', 'cancelled'].includes(s))).toBe('completed');
  return r.body.runId;
}
const fork = (runId: string, body: Json) => api<Json>(`/runs/${runId}:fork`, { method: 'POST', body: JSON.stringify(body) });

describe('ADR 0772 D3 (RRWF-6) — the fork route spends run quota', () => {
  it('a caller at its per-minute run quota is refused a fork with 429', async () => {
    // The bearer path is keyed per IP (daily), a cookie session per minute —
    // both capped at 2 so the test is independent of which key applies.
    process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN = '2';
    process.env.OPENWOP_RATELIMIT_IP_RUNS_PER_DAY = '2';
    const src = await completedRun(); // quota use 1
    expect((await fork(src, { mode: 'replay', fromSeq: 0 })).status).toBe(201); // use 2
    const third = await fork(src, { mode: 'replay', fromSeq: 0 });
    expect(third.status, JSON.stringify(third.body)).toBe(429);
  });

  it('a refused fork (422 fork_point_invalid) costs no quota', async () => {
    process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN = '2';
    process.env.OPENWOP_RATELIMIT_IP_RUNS_PER_DAY = '2';
    const src = await completedRun(); // use 1
    expect((await fork(src, { mode: 'branch', fromSeq: 999_999 })).status).toBe(422);
    expect((await fork(src, { mode: 'replay', fromSeq: 0 })).status).toBe(201); // still use 2
  });
});

describe('ADR 0772 D3 (RRWF-7) — a half-copied fork is failed, never runnable', () => {
  it('a copy that throws part-way answers 500 naming the fork, and the fork row is failed', async () => {
    process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
    const src = await completedRun();
    const events = await storage.listEvents(bareRunId(src));
    const fromSeq = events[events.length - 1]!.sequence; // the source log's last event: a multi-event prefix to copy
    const real = storage.appendEvent.bind(storage);
    let copied = 0;
    const spy = vi.spyOn(storage, 'appendEvent').mockImplementation(async (ev) => {
      // Only the fork's copy loop passes a causationId AND the source timestamp.
      if (ev.causationId && ev.runId !== src && ++copied === 2) throw new Error('simulated storage outage mid-copy');
      return real(ev);
    });
    let res: { status: number; body: Json; location: string | null };
    try {
      res = await fork(src, { mode: 'branch', fromSeq });
    } finally {
      spy.mockRestore();
    }
    expect(res.status, JSON.stringify(res.body)).toBe(500);
    // The id rides `Location`: the error envelope's entropy scrub would redact a
    // UUID placed in `details` or `message`.
    const forkId = (res.location ?? '').replace(/^\/(v1\/)?runs\//, '');
    expect(forkId, `the 500 must name the fork so the client can find it: ${JSON.stringify(res.body)}`).not.toBe('');
    const row = await storage.getRun(bareRunId(forkId));
    expect(row?.status, 'a partial fork must never be left pending for the sweeper').toBe('failed');
    expect(row?.error?.code).toBe('fork_prefix_incomplete');
  });
});

describe('ADR 0772 D3 (RRWF-9) — cancelling a source spares its forks', () => {
  it('an in-flight fork of a cancelled source keeps running to its own terminal', async () => {
    process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
    const create = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'conformance-approval' }) });
    expect(create.status).toBe(201);
    const src = create.body.runId;
    expect(await waitStatus(src, (s) => s.startsWith('waiting'))).toBe('waiting-approval');
    const f = await fork(src, { mode: 'branch', fromSeq: 0 });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    const forkId = String(f.body['runId']);
    expect(await waitStatus(forkId, (s) => s.startsWith('waiting'))).toBe('waiting-approval');

    expect((await api(`/runs/${src}/cancel`, { method: 'POST', body: '{}' })).status).toBeLessThan(300);
    expect(await waitStatus(src, (s) => s === 'cancelled')).toBe('cancelled');
    expect((await api<{ status: string }>(`/runs/${forkId}`)).body.status, 'a fork is a sibling history, not a child execution').toBe('waiting-approval');
    await api(`/runs/${forkId}/cancel`, { method: 'POST', body: '{}' });
  });
});
