/**
 * ADR 0987 — the cross-instance concurrency cap, on two REAL processes sharing one
 * Postgres (S03-T1). P0 reproduced the double admit (`it.fails`); P1's D2
 * (count-in-insert) makes it hold.
 *
 * The session concurrency cap (`OPENWOP_RATELIMIT_SESSION_CONCURRENT`, 5) lives in
 * a per-process map (`middleware/rateLimit.ts` `sessionInflightRuns`). So one signed-
 * in user who sends 3 long runs to instance A and 3 to instance B has 6 running: each
 * instance sees 3, under its cap of 5. The cap the user is promised is per user, not
 * per instance.
 *
 * Each instance is its own OS process (`test/support/appProcess.ts`). The session
 * cookie is signed with a shared secret, so the same user is the same session key on
 * both. The workflow is one `core.delay` of 60 s, registered durably, so it resolves
 * on either instance and every admitted run is still running when the count is taken.
 *
 * Runs against `OPENWOP_PG_TEST_DSN`, else a `postgres:15-alpine` testcontainer when
 * Docker is reachable (`ci:full`), else skips, as the `*-postgres-live` tests do in
 * `npm run ci`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { getSetCookies } from './headerCookies.js';

function dockerReachable(): boolean {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try { execSync('docker info > /dev/null 2>&1', { timeout: 5000 }); return true; } catch { return false; }
}
const externalDsn = process.env.OPENWOP_PG_TEST_DSN;
const available = !!externalDsn || dockerReachable();
let dsn: string | undefined = externalDsn;
let stopContainer: (() => Promise<unknown>) | null = null;
const HERE = import.meta.dirname;
const CAP = 5;

interface Instance { base: string; call: (msg: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>; kill: () => Promise<void> }
async function startInstance(): Promise<Instance> {
  const proc: ChildProcess = spawn(process.execPath, ['--import', 'tsx', join(HERE, 'support', 'appProcess.ts')], {
    cwd: join(HERE, '..'),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      APP_PG_DSN: dsn,
      OPENWOP_STORAGE_DSN: '',
      OPENWOP_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      OPENWOP_TEST_AUTH_ENABLED: 'true',
      OPENWOP_AUTH_DISABLE_COOKIES: '',
      OPENWOP_MOUNT_LOCAL_PACKS: 'false',
      OPENWOP_RATELIMIT_SESSION_CONCURRENT: String(CAP),
      OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN: '1000',
      OPENWOP_RATELIMIT_SESSION_RUNS_PER_DAY: '1000',
      OPENWOP_RATELIMIT_DISABLED: '',
      OPENWOP_LOG_LEVEL: 'error',
      NODE_ENV: 'test',
    },
  });
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  const pending = new Map<number, (r: { ok: boolean; error?: string }) => void>();
  let seq = 0;
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`instance did not boot in 90 s:\n${stderr.slice(-2000)}`)), 90_000);
    proc.on('message', (m: { ready?: boolean; port?: number; id?: number; ok?: boolean; error?: string }) => {
      if (m.ready) { clearTimeout(timer); resolve(m.port!); return; }
      if (m.id !== undefined) pending.get(m.id)?.({ ok: !!m.ok, error: m.error });
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`instance exited ${code}:\n${stderr.slice(-2000)}`)); });
  });
  return {
    base: `http://127.0.0.1:${port}`,
    call: (msg) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); proc.send({ ...msg, id }); }),
    kill: () => new Promise((resolve) => {
      if (proc.exitCode !== null) { resolve(); return; }
      proc.once('exit', () => resolve());
      proc.kill('SIGKILL');
    }),
  };
}

let A: Instance | null = null;
let B: Instance | null = null;
const WF = `wf.adr0987.hold-${Date.now().toString(36)}`;

beforeAll(async () => {
  if (!available) {
    console.warn('[adr0987-admission-two-process-postgres-live] no OPENWOP_PG_TEST_DSN and no Docker — skipping.');
    return;
  }
  if (!dsn) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const c = await new PostgreSqlContainer('postgres:15-alpine').start();
    dsn = c.getConnectionUri();
    stopContainer = () => c.stop();
  }
  A = await startInstance(); // first: runs the schema migration
  B = await startInstance();
  const r = await A.call({ cmd: 'registerWorkflow', def: { workflowId: WF, nodes: [{ nodeId: 'hold', typeId: 'core.delay', config: { durationMs: 60_000 } }], edges: [] } });
  expect(r.ok, r.error).toBe(true);
}, 200_000);
afterAll(async () => {
  await Promise.all([A?.kill(), B?.kill()]);
  await stopContainer?.();
});

async function login(base: string): Promise<string> {
  const r = await fetch(`${base}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `adm-${Date.now()}@acme.test` }),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  for (const c of getSetCookies(r.headers) as string[]) {
    const m = /(__session=[^;]+)/.exec(c);
    if (m) return m[1]!;
  }
  throw new Error('no session cookie');
}
async function startRun(base: string, cookie: string): Promise<number> {
  const r = await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ workflowId: WF, inputs: {} }) });
  await r.arrayBuffer();
  return r.status;
}

describe.skipIf(!available)('ADR 0987 P0 — one user, two instances, one concurrency cap', () => {
  it('positive control: one instance refuses the run past the cap', async () => {
    const cookie = await login(A!.base);
    const statuses: number[] = [];
    for (let i = 0; i < CAP + 1; i += 1) statuses.push(await startRun(A!.base, cookie));
    expect(statuses.filter((s) => s === 201)).toHaveLength(CAP);
    expect(statuses[CAP]).toBe(429);
  }, 60_000);

  it('positive control: instance B serves the same user and workflow (so the case below cannot pass vacuously)', async () => {
    const cookie = await login(A!.base);
    expect(await startRun(B!.base, cookie)).toBe(201);
  }, 60_000);

  // ADR 0987 D2 (P1): the run insert counts this user's pending/running runs across
  // every instance, so 3 + 3 admit exactly 5. Before P1 each instance counted only
  // its own runs and admitted 6 (this case was `it.fails` in P0, #5325).
  it('a user\'s concurrency cap holds across instances: 3 runs on A and 3 on B admit at most 5', async () => {
    const cookie = await login(A!.base);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push(await startRun(A!.base, cookie));
    for (let i = 0; i < 3; i += 1) statuses.push(await startRun(B!.base, cookie));
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(CAP);
  }, 60_000);
});
