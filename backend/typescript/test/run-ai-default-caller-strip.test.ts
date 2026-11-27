/**
 * A caller never chooses the run's AI key (`metadata.aiDefault`).
 *
 * Since #5764 a frozen `source: 'workspace'` AI default names a stored-secret ref,
 * and `stampRunStartContext` never overwrites a key already present. So caller
 * metadata carrying `aiDefault` would pick which of the workspace's stored secrets
 * pays for the run. It is stripped at the three caller-metadata entry points, all
 * through `CALLER_AI_DEFAULT_KEYS` (`host/runLinkage.ts`):
 *   - `stripCallerAttribution` (`POST /runs`, host/runDispatch.ts)
 *   - the scheduler route's job keys (routes/scheduler.ts, RESERVED_JOB_METADATA_KEYS)
 *   - the schedule daemon's spread (host/scheduleDaemon.ts), for a job saved before
 *     the route refused the key.
 * Removing any one of the three reddens the matching case below.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { getJob, registerJob } from '../src/host/schedulingService.js';
import { RUN_AI_DEFAULT_KEY } from '../src/host/runAiDefault.js';
import { stripCallerAttribution } from '../src/host/runDispatch.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let server: http.Server;
let BASE = '';
let storage: Storage;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'aidefault-strip', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  storage = __hostExtStorage()!;
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const PLANTED_REF = 'planted-other-secret';
const planted = (): Record<string, unknown> => ({
  [RUN_AI_DEFAULT_KEY]: { provider: 'anthropic', model: 'claude-sonnet-5-5', source: 'workspace', credentialRef: PLANTED_REF },
  title: 'kept',
});

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const parsed: unknown = await res.json().catch(() => ({}));
    if (!isObj(parsed)) throw new Error(`${method} ${path} → ${res.status}: unexpected body ${JSON.stringify(parsed)}`);
    return { status: res.status, body: parsed };
  };
}

async function signup(): Promise<{ call: ReturnType<typeof client>; tenantId: string; userId: string }> {
  const call = client();
  const r = await call('POST', '/host/openwop-app/test/login', { email: `aidefault-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const user = r.body.user;
  if (!isObj(user) || typeof user.tenantId !== 'string' || typeof user.userId !== 'string') throw new Error(`login body: ${JSON.stringify(r.body)}`);
  return { call, tenantId: user.tenantId, userId: user.userId };
}

/** The planted ref must not be what the run carries (a host-frozen value may be present). */
function expectNotPlanted(row: RunRecord | null | undefined): void {
  expect(row, 'run row').toBeTruthy();
  expect(JSON.stringify(row?.metadata?.[RUN_AI_DEFAULT_KEY] ?? null)).not.toContain(PLANTED_REF);
  expect(row?.metadata?.['title']).toBe('kept');
}

async function firedRun(tenantId: string, jobId: string): Promise<RunRecord | undefined> {
  const rows = await storage.listRuns({ tenantId, limit: 50 });
  return rows.find((r) => isObj(r.metadata?.['schedule']) && (r.metadata?.['schedule'] as Record<string, unknown>).jobId === jobId);
}

describe('a caller never chooses the run\'s AI key', () => {
  it('stripCallerAttribution drops aiDefault and keeps ordinary metadata', () => {
    const out = stripCallerAttribution(planted());
    expect(out[RUN_AI_DEFAULT_KEY]).toBeUndefined();
    expect(out['title']).toBe('kept');
  });

  it('POST /runs: aiDefault in caller metadata is not persisted', async () => {
    const { call } = await signup();
    const r = await call('POST', '/runs', { workflowId: 'conformance-noop', inputs: {}, metadata: planted() });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const runId = String(r.body.runId);
    expectNotPlanted(await storage.getRun(runId.slice(runId.lastIndexOf('/') + 1)));
  });

  it('the scheduler route refuses aiDefault on a saved job, and its fired run does not carry it', async () => {
    const { call } = await signup();
    const job = await call('POST', '/host/openwop-app/scheduler/jobs', { cronExpr: '0 0 1 1 *', workflowId: 'conformance-noop', metadata: planted() });
    expect(job.status, JSON.stringify(job.body)).toBeLessThan(300);
    const jobId = String((isObj(job.body.job) ? job.body.job.jobId : undefined) ?? job.body.jobId ?? '');
    expect(jobId).not.toBe('');
    const stored = await getJob(jobId);
    expect(stored?.metadata?.[RUN_AI_DEFAULT_KEY]).toBeUndefined();
    expect(stored?.metadata?.['title']).toBe('kept');
  });

  it('a job saved BEFORE the route refused the key does not carry it onto the runs it fires (daemon filter)', async () => {
    const { call, tenantId, userId } = await signup();
    const jobId = `aidefault-legacy-${n++}`;
    const reg = await registerJob({ jobId, tenantId, cronExpr: '0 0 1 1 *', workflowId: 'conformance-noop', metadata: { actingUserId: userId, ...planted() } });
    expect(reg.ok).toBe(true);
    // CONTROL: the stored job really does hold the planted value (the route did not run).
    expect(JSON.stringify((await getJob(jobId))?.metadata?.[RUN_AI_DEFAULT_KEY] ?? null)).toContain(PLANTED_REF);
    const fired = await call('POST', `/host/openwop-app/scheduler/jobs/${encodeURIComponent(jobId)}/trigger`);
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    expect(fired.body.runsFired).toBe(1);
    expectNotPlanted(await firedRun(tenantId, jobId));
  });
});
