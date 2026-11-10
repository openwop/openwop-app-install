/**
 * TST-FIB-GC1 — ADR 1014 review M1 regressed: the revision head must number the agent
 * as STORED, never a caller's copy. Found by grade-tests w83 (1b) at a5ce0b304, with a
 * forced race the unforced M1 case (`Promise.all` of two edits) never produces.
 *
 * Case 1, the route. Edit A's CAS lands and A is parked; edit B saves and answers; A
 * resumes. A used to number its OWN copy, so the head became 3 = 'a' while the agent
 * held 'b'. Hold: the first successful `updateUserAgent` waits until B has answered.
 *
 * Case 2, `alignHead` itself. Aligner X writes revision row N and is parked before its
 * head CAS; the stored agent moves on; aligner Y finds row N taken. Y used to ignore
 * the failed row write and point the head at N anyway, so the head named Y's content
 * while row N held X's. Hold: the first revision-head CAS waits until Y returns.
 *
 * Sabotage (each witnessed red): number `updated` instead of the re-read (case 1);
 * ignore the failed row write, as before (case 2); drop the `reload` on retry (case 2,
 * X re-numbers stale content above the head). Both cases are red on 96cd0524a.
 * Also witnessed (w89): registering the caller's copy instead of the stored record,
 * and the response naming the head instead of its own content's revision (case 1);
 * an aligner that does not finish the other aligner's head step (case 2). Each hold
 * waits at most 5 s and then fails by name, so a sabotage that bypasses the held call
 * reds instead of hanging.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { enableToggle } from './planningHarness.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { alignHead, currentRevision, getRevision } from '../src/host/userAgentRevisions.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';

let server: http.Server;
let BASE = '';
let seq = 0;
interface Res<T = unknown> { status: number; body: T }
/** The fields this file reads from the agent create / PATCH responses. */
interface AgentBody { agentId: string; packVersion: string; systemPrompt: string }

function client() {
  let cookie = '';
  return async <T = unknown>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
}

async function owner() {
  const tenantId = `org:gc1-${Date.now()}-${seq++}`;
  const call = client();
  expect((await call('POST', '/host/openwop-app/test/login', { email: `gc1-${Date.now()}-${seq++}@acme.test`, tenantId })).status).toBe(201);
  expect((await call('POST', '/host/openwop-app/orgs', { name: 'GC1' })).status).toBe(201);
  const agent = await call<AgentBody>('POST', '/host/openwop-app/agents', { persona: 'Racer', modelClass: 'chat', systemPrompt: 'v1' });
  expect(agent.status, JSON.stringify(agent.body)).toBe(201);
  const agentId = agent.body.agentId;
  return { tenantId, call, agentId, path: `/host/openwop-app/agents/${encodeURIComponent(agentId)}` };
}

/** A one-shot park: the first call that `match`es waits for `release()`. */
function oneShotHold() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let arrived!: () => void;
  const parked = new Promise<void>((r) => { arrived = r; });
  let used = false;
  return { gate, parked, release, take: (): boolean => { if (used) return false; used = true; arrived(); return true; } };
}

/** Wait for the hold to fire, but fail by name (never hang to the case timeout) when
 *  the path under test no longer reaches the held call. */
async function parkedWithin(hold: { parked: Promise<void> }, ms = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fired = await Promise.race([
    hold.parked.then(() => true),
    new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); }),
  ]);
  clearTimeout(timer);
  expect(fired, 'the hold never fired: the path did not reach the held call').toBe(true);
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await enableToggle('users', 'on');
}, 60_000);
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

describe('TST-FIB-GC1 — the revision head numbers the stored agent', () => {
  it('a delayed edit numbers what is stored, not its own copy (route)', async () => {
    const o = await owner();
    const s: Storage = hostExtStorage();
    const orig = s.updateUserAgent.bind(s);
    const hold = oneShotHold();
    s.updateUserAgent = async (...args: Parameters<Storage['updateUserAgent']>) => {
      const ok = await orig(...args);
      if (ok && hold.take()) await hold.gate;
      return ok;
    };
    let a: Res<AgentBody>, b: Res<AgentBody>;
    try {
      const pending = o.call<AgentBody>('PATCH', o.path, { systemPrompt: 'a' });
      await parkedWithin(hold); // A's CAS has landed
      b = await o.call<AgentBody>('PATCH', o.path, { systemPrompt: 'b' });
      hold.release();
      a = await pending;
    } finally {
      s.updateUserAgent = orig;
    }
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const stored = await s.getUserAgent(o.tenantId, o.agentId);
    expect(stored?.systemPrompt).toBe('b');
    const head = await currentRevision(o.tenantId, o.agentId);
    expect((await getRevision(o.tenantId, o.agentId, head))?.systemPrompt, 'the head names the stored content').toBe('b');
    // The history: v1, then a (numbered by B's catch-up), then b. Nothing past it.
    expect(head).toBe('2');
    expect((await getRevision(o.tenantId, o.agentId, '1'))?.systemPrompt).toBe('a');
    expect(await getRevision(o.tenantId, o.agentId, '3'), 'no revision for stale content').toBeNull();
    // Each response names its own content's revision; the registry holds what is stored.
    expect(a.body.packVersion).toBe('1');
    expect(b.body.packVersion).toBe('2');
    expect((await getAgentRegistry().resolve(o.agentId, o.tenantId))?.systemPrompt).toBe('b');
  });

  it('an aligner that finds its revision row taken never points the head at it (alignHead)', async () => {
    const o = await owner();
    const s: Storage = hostExtStorage();
    const base = await s.getUserAgent(o.tenantId, o.agentId);
    if (!base) throw new Error('agent not stored');
    const reload = () => s.getUserAgent(o.tenantId, o.agentId);
    const store = async (systemPrompt: string) => {
      const next = { ...base, systemPrompt };
      expect(await s.updateUserAgent(o.tenantId, next)).toBe(true);
      return next;
    };
    expect(await alignHead(base)).toBe('0');

    const x = await store('x');
    const origCas = s.kvCompareAndSwap.bind(s);
    const hold = oneShotHold();
    s.kvCompareAndSwap = async (...args: Parameters<Storage['kvCompareAndSwap']>) => {
      if (String(args[0]).includes('user-agent-revision-heads') && hold.take()) await hold.gate;
      return origCas(...args);
    };
    let xRev: string, yRev: string;
    try {
      const pendingX = alignHead(x, undefined, reload); // writes row 1 = x, parks before its head CAS
      await parkedWithin(hold);
      const y = await store('y');
      yRev = await alignHead(y, undefined, reload);
      hold.release();
      xRev = await pendingX;
    } finally {
      s.kvCompareAndSwap = origCas;
    }

    const head = await currentRevision(o.tenantId, o.agentId);
    expect((await getRevision(o.tenantId, o.agentId, head))?.systemPrompt, 'the head names the stored content').toBe('y');
    expect(head).toBe('2');
    expect((await getRevision(o.tenantId, o.agentId, '1'))?.systemPrompt, 'row 1 keeps x').toBe('x');
    expect(await getRevision(o.tenantId, o.agentId, '3'), 'stale x is not re-numbered').toBeNull();
    expect(yRev).toBe('2');
    expect(xRev, 'X reports the head it found on the stored content').toBe('2');
  });
});
