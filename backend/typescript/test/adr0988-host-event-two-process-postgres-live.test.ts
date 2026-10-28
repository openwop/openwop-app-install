/**
 * ADR 0988 D4 (P1) — host events across REAL processes on REAL Postgres: witnesses
 * S04-T1 and S04-T2 at the scope the gap-closure plan requires, against today's code.
 *
 * ADR 0973's own tests boot one process on `memory://` and simulate a restart. That
 * cannot show the Postgres LISTEN/NOTIFY hand-off between instances, nor a resume
 * served by a process that never saw the events. Here each instance is its own OS
 * process (`test/support/hostEventProcess.ts`, one `createApp` each) on one
 * database:
 *
 *   - S04-T1: an event over NOTIFY's 7,900-byte limit, emitted on A, reaches a
 *     subscriber connected to B with the same id (A publishes `{seq, eventId}`;
 *     B reads the row from the log);
 *   - contention: 8 durable events emitted at once, 4 from each process, on one
 *     tenant's log head (production's measured burst is 7 per second on one head,
 *     ADR 0988 D5) all commit, and replay in one gap-free order;
 *   - S04-T2: A emits a backlog and is killed with no drain; a FRESH process C
 *     answers `Last-Event-ID` + `replay=required` with exactly the later durable
 *     events, in commit order, and no ephemeral frame;
 *   - legacy unchanged (RFC 0250 `0250.legacy-unchanged`): on C, an unknown cursor
 *     without the parameter still opens the stream;
 *   - S04-T1 fault (ADR 0988 D2): with A's appends forced to fail, an oversized
 *     event is dead-lettered (visible from B) and reaches no subscriber, on A or B;
 *   - S04-T2 legacy (ADR 0988 D1): a KNOWN cursor without the parameter on C
 *     resumes from the log. Before D1 it resumed live, from C's empty ring, and the
 *     backlog was lost (`it.fails` in P1).
 *
 * Runs against `OPENWOP_PG_TEST_DSN` (this Mac: Homebrew postgresql@15), else a
 * `postgres:15-alpine` testcontainer when Docker is reachable (`ci:full`), else
 * skips, as the `*-postgres-live` tests do in `npm run ci`.
 *
 * Sabotage-witnessed (2026-10-27, real Postgres 15.19):
 *   - an oversized event falling back to local-only delivery reds S04-T1;
 *   - the head CAS giving up after 1 attempt (it allows 8) reds the burst case, so
 *     the bound is what carries 8 concurrent emits across two processes.
 * Without a DSN or Docker all 5 cases skip.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import type { HostEventEnvelope } from '../src/host/hostEventTypes.js';

function dockerReachable(): boolean {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try { execSync('docker info > /dev/null 2>&1', { timeout: 5000 }); return true; } catch { return false; }
}
const externalDsn = process.env.OPENWOP_PG_TEST_DSN;
const available = !!externalDsn || dockerReachable();
let dsn: string | undefined = externalDsn;
let stopContainer: (() => Promise<unknown>) | null = null;
const HERE = import.meta.dirname;

interface Reply { ok: boolean; error?: string; summary?: { total: number } }
interface Instance { proc: ChildProcess; base: string; call: (msg: Record<string, unknown>) => Promise<Reply>; kill: () => Promise<void> }

async function startInstance(): Promise<Instance> {
  const proc = spawn(process.execPath, ['--import', 'tsx', join(HERE, 'support', 'hostEventProcess.ts')], {
    cwd: join(HERE, '..'),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      HOST_EVENT_PG_DSN: dsn,
      OPENWOP_STORAGE_DSN: '',
      OPENWOP_HOST_EVENTS_V2: 'true',
      OPENWOP_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      OPENWOP_TEST_AUTH_ENABLED: 'true',
      OPENWOP_AUTH_DISABLE_COOKIES: '',
      OPENWOP_MOUNT_LOCAL_PACKS: 'false',
      OPENWOP_INSTANCE_TOPOLOGY: 'multi', // two processes on one database: honestly multi-instance
      OPENWOP_LOG_LEVEL: 'error',
      NODE_ENV: 'test',
    },
  });
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  const pending = new Map<number, (r: Reply) => void>();
  let seq = 0;
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`instance did not boot in 90 s:\n${stderr.slice(-2000)}`)), 90_000);
    proc.on('message', (m: { ready?: boolean; port?: number; id?: number; ok?: boolean; error?: string; summary?: { total: number } }) => {
      if (m.ready) { clearTimeout(timer); resolve(m.port!); return; }
      if (m.id !== undefined) pending.get(m.id)?.({ ok: !!m.ok, error: m.error, summary: m.summary });
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`instance exited ${code}:\n${stderr.slice(-2000)}`)); });
  });
  return {
    proc,
    base: `http://127.0.0.1:${port}`,
    call: (msg) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); proc.send({ ...msg, id }); }),
    kill: () => new Promise((resolve) => {
      if (proc.exitCode !== null) { resolve(); return; }
      proc.once('exit', () => resolve());
      proc.kill('SIGKILL');
    }),
  };
}

let n = 0;
async function login(base: string, tenantId: string): Promise<string> {
  const r = await fetch(`${base}/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `tp-${Date.now()}-${n++}@acme.test`, tenantId }),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  for (const c of getSetCookies(r.headers) as string[]) {
    const m = /(__session=[^;]+)/.exec(c);
    if (m) return m[1]!;
  }
  throw new Error('no session cookie');
}

interface Stream { text: () => string; status: number; close: () => void }
function openStream(base: string, opts: { cookie: string; lastEventId?: string; replay?: boolean }): Promise<Stream> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const req = http.get(`${base}/host/events${opts.replay ? '?replay=required' : ''}`, {
      headers: {
        accept: 'text/event-stream', 'openwop-version': '2', cookie: opts.cookie,
        ...(opts.lastEventId !== undefined ? { 'last-event-id': opts.lastEventId } : {}),
      },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d: string) => { buf += d; });
      const s: Stream = { text: () => buf, status: res.statusCode ?? 0, close: () => req.destroy() };
      if (!String(res.headers['content-type'] ?? '').includes('text/event-stream')) { res.on('end', () => resolve(s)); return; }
      const wait = (): void => { if (buf.includes(': open')) resolve(s); else setTimeout(wait, 5); };
      wait();
    });
    req.on('error', (e) => { if (!/socket hang up|aborted/.test(String(e))) reject(e); });
  });
}
async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}
const runTag = Date.now().toString(16).slice(-8);
const OURS = `hev-00000000-0000-4000-8000-${runTag}`;
/** The ids of the events THIS test emitted, in stream order. Signing in emits the
 *  tenant's own durable `users-user-provisioned` event, which arrives live and is
 *  not under test here. */
const eventIds = (text: string): string[] =>
  text.split('\n\n').filter((b) => b.length > 0 && !b.startsWith(':'))
    .map((b) => /^id: (.+)$/m.exec(b)?.[1] ?? '(no id)')
    .filter((id) => id.startsWith(OURS));
let k = 0;
const newId = (): string => `${OURS}${(k++).toString(16).padStart(4, '0')}`;
function ev(eventId: string, opts: { delivery?: 'durable' | 'ephemeral'; bytes?: number } = {}): HostEventEnvelope {
  const delivery = opts.delivery ?? 'durable';
  return {
    eventId,
    type: delivery === 'durable' ? 'example.thing-happened' : 'example.thing-noticed',
    timestamp: new Date().toISOString(),
    delivery,
    payload: opts.bytes ? { blob: 'x'.repeat(opts.bytes) } : {},
  };
}

let A: Instance | null = null;
let B: Instance | null = null;
let C: Instance | null = null;

beforeAll(async () => {
  if (!available) {
    console.warn('[adr0988-host-event-two-process-postgres-live] no OPENWOP_PG_TEST_DSN and no Docker — skipping.');
    return;
  }
  if (!dsn) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const c = await new PostgreSqlContainer('postgres:15-alpine').start();
    dsn = c.getConnectionUri();
    stopContainer = () => c.stop();
  }
  // Sequential boots: the first one runs the schema migration.
  A = await startInstance();
  B = await startInstance();
}, 200_000);
afterAll(async () => {
  await Promise.all([A?.kill(), B?.kill(), C?.kill()]);
  await stopContainer?.();
});

describe.skipIf(!available)('ADR 0988 — host events across two real processes on Postgres', () => {
  it('S04-T1: an oversized event emitted on A reaches a subscriber on B, same id', async () => {
    const T = `org:two-proc-t1-${runTag}`;
    const cookie = await login(B!.base, T);
    const s = await openStream(B!.base, { cookie });
    expect(s.status).toBe(200);
    const big = newId();
    const r = await A!.call({ cmd: 'fanout', tenantId: T, event: ev(big, { bytes: 9000 }) });
    expect(r.ok, r.error).toBe(true);
    await until(() => eventIds(s.text()).includes(big));
    s.close();
    expect(eventIds(s.text())).toEqual([big]);
    expect(s.text().length).toBeGreaterThan(9000); // the body arrived, not only a reference
  }, 60_000);

  it('S04-T1 fault (D2): an oversized event whose append fails is dead-lettered, never delivered on A only', async () => {
    const T = `org:two-proc-d2-${runTag}`;
    const cookieA = await login(A!.base, T);
    const cookieB = await login(B!.base, T);
    const onA = await openStream(A!.base, { cookie: cookieA });
    const onB = await openStream(B!.base, { cookie: cookieB });
    const before = (await A!.call({ cmd: 'deadLetters' })).summary!.total;
    expect((await A!.call({ cmd: 'failAppends', count: 4 })).ok).toBe(true);
    const big = newId();
    expect((await A!.call({ cmd: 'fanout', tenantId: T, event: ev(big, { bytes: 9000 }) })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    onA.close();
    onB.close();
    expect(eventIds(onA.text())).toEqual([]); // not local-only on A
    expect(eventIds(onB.text())).toEqual([]);
    expect((await B!.call({ cmd: 'deadLetters' })).summary!.total).toBe(before + 1); // visible from the other process
  }, 60_000);

  it('8 concurrent durable emits from both processes on one tenant head all commit, in one gap-free order', async () => {
    const T = `org:two-proc-burst-${runTag}`;
    const first = newId();
    expect((await A!.call({ cmd: 'fanout', tenantId: T, event: ev(first) })).ok).toBe(true);
    const ids = Array.from({ length: 8 }, () => newId());
    const results = await Promise.all(ids.map((id, i) => (i % 2 === 0 ? A! : B!).call({ cmd: 'fanout', tenantId: T, event: ev(id) })));
    expect(results.every((r) => r.ok)).toBe(true);
    // Every one is in the durable log: a replay from `first` returns all 8, once each.
    const cookie = await login(B!.base, T);
    const s = await openStream(B!.base, { cookie, lastEventId: first, replay: true });
    expect(s.status).toBe(200);
    await until(() => ids.every((id) => eventIds(s.text()).includes(id)));
    s.close();
    const got = eventIds(s.text());
    expect([...got].sort()).toEqual([...ids].sort());
    expect(new Set(got).size).toBe(got.length);
  }, 60_000);

  describe('a backlog on A, A killed, a fresh process C', () => {
    const T = `org:two-proc-t2-${runTag}`;
    const d = [newId(), newId(), newId()];
    const eph = newId();

    beforeAll(async () => {
      if (!available) return;
      for (const e of [ev(d[0]!), ev(d[1]!), ev(eph, { delivery: 'ephemeral' }), ev(d[2]!)]) {
        const r = await A!.call({ cmd: 'fanout', tenantId: T, event: e });
        expect(r.ok, r.error).toBe(true);
      }
      await A!.kill();
      A = null;
      C = await startInstance();
    }, 120_000);

    it('S04-T2: Last-Event-ID + replay=required on C returns the later durable events in commit order, no ephemeral', async () => {
      const cookie = await login(C!.base, T);
      const s = await openStream(C!.base, { cookie, lastEventId: d[0]!, replay: true });
      expect(s.status).toBe(200);
      await until(() => eventIds(s.text()).includes(d[2]!));
      s.close();
      expect(eventIds(s.text())).toEqual([d[1], d[2]]);
    }, 60_000);

    it('legacy unchanged: an unknown cursor without the parameter still opens the stream on C', async () => {
      const cookie = await login(C!.base, T);
      const s = await openStream(C!.base, { cookie, lastEventId: newId() });
      s.close();
      expect(s.status).toBe(200);
    }, 30_000);

    // ADR 0988 D1: a known cursor without `replay=required` resumes from the durable
    // log. C's ring is empty, so before D1 the stream opened live and lost the backlog
    // (this case was `it.fails` in P1, #5321).
    it('S04-T2 legacy (D1): a known cursor without the parameter resumes from the log on C', async () => {
      const cookie = await login(C!.base, T);
      const s = await openStream(C!.base, { cookie, lastEventId: d[0]! });
      await until(() => eventIds(s.text()).includes(d[2]!), 3000);
      s.close();
      expect(eventIds(s.text())).toEqual([d[1], d[2]]);
    }, 30_000);
  });
});
