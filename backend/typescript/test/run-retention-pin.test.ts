/**
 * ADR 0371 Phase 5 — the retention pin at the run surface: POST pin toggles
 * run.metadata.pinned and the P2 sweeper honors it (a pinned run survives a
 * past-deadline sweep).
 *
 * ADR 0812 — `pinned` and `removalAt` are READ from
 * `GET /host/openwop-app/runs/{id}/pin`. The v1 snapshot used to carry both, but
 * major 2's closed RunSnapshot does not, and the SPA has spoken major 2 since v1
 * retired. Its run page therefore read `!snapshot.pinned` as always true and could
 * never unpin. The host lane keys a run by its bare id; the protocol lane returns
 * it tenant-bound.
 *
 * Breaks it (round-1 probes, witnessed): unpin ignored (8fw2g2-rrp-unpin), the
 * read hard-coding `pinned` (rrp-read), the read dropping `removalAt`
 * (rrp-removal). `removalAt` is now pinned to completedAt + the suite's 30-day
 * TTL (± 0.1 d), and the cross-tenant 404 body is compared with the 404 for an
 * id that exists nowhere — identical bodies are the "no existence oracle" claim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { mintAnonSession, signSession } from '../src/middleware/cookieSession.js';

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET ??= 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_RUN_RETENTION_DAYS = '30'; // retention is OFF by default now — enable it for this suite
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { delete process.env.OPENWOP_RUN_RETENTION_DAYS; await new Promise<void>((res) => server.close(() => res())); });

const DEV = { authorization: 'Bearer dev-token' };
async function j<T = Record<string, unknown>>(path: string, init: RequestInit = {}, auth: Record<string, string> = DEV): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', ...auth, ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}
const bare = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
type Retention = { runId?: string; pinned?: boolean; removalAt?: string };

/** A completed run; returns its BOUND id (the protocol lane's spelling). */
async function makeTerminalRun(): Promise<string> {
  const wfId = `pin-wf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await j('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId: wfId, nodes: [{ nodeId: 'a', typeId: 'core.noop' }] }) });
  const create = await j<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId: wfId, inputs: {} }) });
  expect(create.status).toBe(201);
  const runId = create.body.runId;
  let status = '';
  for (let i = 0; i < 60; i++) {
    status = (await j<{ status: string }>(`/runs/${encodeURIComponent(runId)}`)).body.status;
    if (status === 'completed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // The poll must not exit silently into a non-terminal run (no removalAt then).
  expect(status, `run ${runId} never completed`).toBe('completed');
  return runId;
}
const readPin = (runId: string, auth?: Record<string, string>) => j<Retention>(`/host/openwop-app/runs/${bare(runId)}/pin`, {}, auth);

describe('run retention pin (ADR 0371 P5)', () => {
  it('the read projects removalAt after a terminal transition, unpinned by default', async () => {
    const before = Date.now();
    const runId = await makeTerminalRun();
    const after = Date.now();
    const r = await readPin(runId);
    expect(r.status).toBe(200);
    // completedAt + the 30-day TTL this suite sets (± 0.1 day of slack for the run's own duration).
    const DAY = 86_400_000;
    const at = Date.parse(String(r.body.removalAt));
    expect(Number.isFinite(at), `removalAt ${r.body.removalAt} is not a timestamp`).toBe(true);
    expect(at).toBeGreaterThanOrEqual(before + 29.9 * DAY);
    expect(at).toBeLessThanOrEqual(after + 30.1 * DAY);
    expect(r.body.pinned).toBe(false);
  });

  it('POST pin sets run.metadata.pinned; the read reflects it; unpin clears it (the sweep-honors-pin path is P2-covered)', async () => {
    const runId = await makeTerminalRun();
    expect((await j(`/host/openwop-app/runs/${bare(runId)}/pin`, { method: 'POST' })).status).toBe(200);
    expect((await readPin(runId)).body.pinned).toBe(true);

    expect((await j(`/host/openwop-app/runs/${bare(runId)}/pin`, { method: 'POST', body: JSON.stringify({ pinned: false }) })).status).toBe(200);
    expect((await readPin(runId)).body.pinned).toBe(false);
  });

  it('ADR 0812 — the major-2 snapshot does NOT carry the pin, which is why the read exists', async () => {
    const runId = await makeTerminalRun();
    expect((await j(`/host/openwop-app/runs/${bare(runId)}/pin`, { method: 'POST' })).status).toBe(200);
    const snap = await j<Retention>(`/runs/${encodeURIComponent(runId)}`);
    expect(snap.status).toBe(200);
    // If a future corpus seats these on RunSnapshot, this goes red and the SPA can
    // read the snapshot again; until then, the host read is the only source.
    expect(snap.body.pinned).toBeUndefined();
    expect(snap.body.removalAt).toBeUndefined();
    expect((await readPin(runId)).body.pinned).toBe(true);
  });

  it('a caller from another tenant is 404ed, with no existence oracle', async () => {
    const runId = await makeTerminalRun();
    expect((await readPin(runId)).status, 'positive control: the owner reads it').toBe(200);
    const anon = { cookie: `__session=${signSession(mintAnonSession())}` };
    const foreign = await readPin(runId, anon);
    expect(foreign.status).toBe(404);
    // No existence oracle: the refusal for a REAL foreign run reads exactly like
    // the refusal for an id that exists nowhere (ids normalised out of the body).
    const ghostId = '00000000-0000-4000-8000-000000000000';
    const ghost = await readPin(ghostId, anon);
    expect(ghost.status).toBe(404);
    const scrub = (body: unknown, id: string): string => JSON.stringify(body).split(id).join('<id>');
    expect(scrub(foreign.body, bare(runId))).toBe(scrub(ghost.body, ghostId));
    expect(JSON.stringify(foreign.body)).not.toContain('pinned');
  });
});
