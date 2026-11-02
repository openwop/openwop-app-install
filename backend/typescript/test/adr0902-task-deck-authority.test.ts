/**
 * ADR 0902 — the task deck (feature loop round 2 row 50).
 *
 * The deck is a read-only projection of "the runs I own + the work they
 * delegated". Every leg below drives the real `GET /host/openwop-app/tasks`
 * route against rows the real run-create path wrote, or rows seeded in the
 * exact shape a host writer produces (a fork, a dispatched child), because the
 * ownership and linkage rules are only meaningful against those stamps.
 *
 * Each refusal is paired with an acceptance, so a host that hides everything
 * cannot pass.
 *
 * Sabotage-witnessed (w73 round 1, each red here and nowhere else in this file):
 *   - D1: dropping `requireProtocolScope(req, 'runs:read')` in task-deck/routes.ts.
 *   - D2: dropping CALLER_LINKAGE_KEYS from `stripCallerAttribution` (runDispatch.ts),
 *     the wildcard check or the same-tenant parent check in `admittedLinkage`
 *     (routes/runs.ts), the scheduler route's reserved job keys, the schedule
 *     daemon's spread filter, or redrive's linkage strip (workflowDebug.ts).
 *     The scheduled-job path is a DOUBLE GUARD (route strip + daemon filter); the
 *     route half is asserted on the stored job, the daemon half by the legacy-job
 *     case, so each guard has its own witness.
 *   - D3: dropping the `forkMode` check in `linkedParentOf`.
 *   - D4: widening the owner filter to the whole tenant; dropping the personal-
 *     workspace rule on either the HTTP or the tool viewer.
 *   - D5/D6/TD2CD-3/TD2UX: `truncated` never true, counts taken after the cap, the
 *     interrupt lookups run for every scoped run, the cancelled flag, the workflow
 *     display name.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { opaquePrincipal } from '../src/host/runOwner.js';
import { getJob, registerJob } from '../src/host/schedulingService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { TASKS_DECK_TOOL_ID } from '../src/features/task-deck/agentTools.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { TaskCard, TaskDeck } from '../src/features/task-deck/taskDeckProjection.js';

let server: http.Server;
let BASE = '';
let storage: Storage;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0902', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  storage = __hostExtStorage()!;
  for (const id of ['users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** Every body is parsed as `unknown` and narrowed by a guard at the call site (the
 *  product type where one exists), so a wrong shape fails loudly instead of reading
 *  `undefined`. */
interface Res<T> { status: number; body: T }
type Guard<T> = (x: unknown) => x is T;
interface ErrorBody { error?: unknown; message?: unknown }
interface DeckBody { deck: TaskDeck }
interface LoginBody { user: { userId: string; tenantId: string } }
interface RunBody { runId: string }
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isUnknown = (_x: unknown): _x is unknown => true;
const isErrorBody = (x: unknown): x is ErrorBody => isObj(x);
const isDeck = (x: unknown): x is TaskDeck => isObj(x) && isObj(x.buckets) && isObj(x.counts) && typeof x.truncated === 'boolean';
const isDeckBody = (x: unknown): x is DeckBody => isObj(x) && isDeck(x.deck);
const isLoginBody = (x: unknown): x is LoginBody => isObj(x) && isObj(x.user) && typeof x.user.userId === 'string' && typeof x.user.tenantId === 'string';
const isRunBody = (x: unknown): x is RunBody => isObj(x) && typeof x.runId === 'string';
const isWorkspaceBody = (x: unknown): x is { workspaceId: string } => isObj(x) && typeof x.workspaceId === 'string';
const isJobBody = (x: unknown): x is { job?: { jobId: string }; jobId?: string } => isObj(x) && ((isObj(x.job) && typeof x.job.jobId === 'string') || typeof x.jobId === 'string');
const isRedriveBody = (x: unknown): x is { results: Array<{ redriveRunId?: string }> } => isObj(x) && Array.isArray(x.results);
function parseAs<T>(text: string, is: Guard<T>): T {
  const parsed: unknown = JSON.parse(text);
  if (!is(parsed)) throw new Error(`unexpected body: ${text.slice(0, 300)}`);
  return parsed;
}
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, is: Guard<T>, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const parsed: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    if (!is(parsed)) throw new Error(`${method} ${path} → ${res.status}: unexpected body ${JSON.stringify(parsed)}`);
    return { status: res.status, body: parsed };
  };
  return {
    get: <T>(p: string, is: Guard<T>, h?: Record<string, string>) => call('GET', p, is, undefined, h),
    post: (p: string, b?: unknown) => call('POST', p, isUnknown, b),
    postAs: <T>(p: string, b: unknown, is: Guard<T>) => call('POST', p, is, b),
  };
}
type Client = ReturnType<typeof client>;
const raw = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
const DECK = '/host/openwop-app/tasks';

async function signup(c: Client, tag: string): Promise<{ userId: string; tenantId: string }> {
  const r = await c.postAs('/host/openwop-app/test/login', { email: `adr0902-${tag}-${Date.now()}-${n++}@acme.test` }, isLoginBody);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
async function startRun(c: Client, metadata?: Record<string, unknown>): Promise<string> {
  const r = await c.postAs('/runs', { workflowId: 'conformance-noop', inputs: {}, ...(metadata ? { metadata } : {}) }, isRunBody);
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return raw(r.body.runId);
}
/** A shared workspace with an owner and an editor member, both switched into it. */
async function sharedWorkspace(): Promise<{ a: Client; b: Client; ws: string; aUser: string; bUser: string }> {
  const a = client();
  const au = await signup(a, 'a');
  const ws = (await a.postAs('/host/openwop-app/workspaces', { name: `TD-${n++}` }, isWorkspaceBody)).body.workspaceId;
  expect((await a.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  const b = client();
  const bu = await signup(b, 'b');
  const add = await a.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'B', subject: bu.userId, roles: ['editor'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  expect((await b.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  return { a, b, ws, aUser: au.userId, bUser: bu.userId };
}

function allCards(deck: Pick<TaskDeck, 'buckets'>): TaskCard[] {
  const out: TaskCard[] = [];
  const walk = (c: TaskCard): void => { out.push(c); c.children.forEach(walk); };
  Object.values(deck.buckets).flat().forEach(walk);
  return out;
}
function findCard(deck: Pick<TaskDeck, 'buckets'>, runId: string): TaskCard | undefined {
  return allCards(deck).find((c) => c.runId === runId);
}
const topLevelIds = (deck: Pick<TaskDeck, 'buckets'>): string[] => Object.values(deck.buckets).flat().map((c) => c.runId);

async function seed(r: Partial<RunRecord> & Pick<RunRecord, 'runId' | 'tenantId' | 'metadata'>, at: string): Promise<void> {
  const row: RunRecord = { workflowId: 'wf', status: 'running', inputs: {}, configurable: {}, createdAt: at, updatedAt: at, ...r };
  await storage.insertRun(row);
}
const ownerStamp = (subject: string) => ({ owner: { principal: opaquePrincipal(subject), principalKind: 'user', subject: { issuer: 'urn:openwop-app:session', subjectId: opaquePrincipal(subject), lane: 'api-key', kind: 'user' } } });

describe('ADR 0902 D1 — the deck is a runs:read surface', () => {
  // The vendor lane itself needs `workspace:read` on a key (ADR 0755 key-lane
  // scope); the deck reads RUNS, so it must also need `runs:read`, as `GET /runs` does.
  it('a key that does not hold runs:read is refused the deck', async () => {
    const c = client();
    const u = await signup(c, 'key');
    const { token } = await issueApiKey({ tenantId: u.tenantId, name: 'adr0902', createdBy: u.userId, scopes: ['workspace:read'] });
    const r = await client().get(DECK, isErrorBody, { authorization: `Bearer ${token}` });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    // The scope refusal itself (`refuseScope`), not some other 403.
    expect(r.body).toMatchObject({ error: 'forbidden', message: 'Missing required scope: runs:read' });
  });

  it('CONTROL: the same key holding runs:read reads it', async () => {
    const c = client();
    const u = await signup(c, 'key2');
    const { token } = await issueApiKey({ tenantId: u.tenantId, name: 'adr0902', createdBy: u.userId, scopes: ['workspace:read', 'runs:read'] });
    const r = await client().get(DECK, isDeckBody, { authorization: `Bearer ${token}` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.deck.buckets).toBeTruthy();
  });
});

describe('ADR 0902 D2 — a caller cannot plant a card in another member\'s deck', () => {
  it('a member\'s run naming another member\'s run as its parent is not shown as delegated work', async () => {
    const { a, b } = await sharedWorkspace();
    const aRun = await startRun(a);
    const planted = await startRun(b, { parentRunId: aRun, delegatedBy: 'agent:iris', title: 'Approve the wire transfer' });
    const deck = await a.get(DECK, isDeckBody);
    expect(deck.status).toBe(200);
    expect(findCard(deck.body.deck, aRun), 'own run present').toBeTruthy();
    expect(findCard(deck.body.deck, planted), 'B\'s run must not ride into A\'s deck').toBeUndefined();
    expect(JSON.stringify(deck.body)).not.toContain('Approve the wire transfer');
  });

  it('the linkage a caller supplied is not persisted as host linkage', async () => {
    const { a, b } = await sharedWorkspace();
    const aRun = await startRun(a);
    const planted = await startRun(b, { parentRunId: aRun, delegatedBy: 'agent:iris' });
    const row = await storage.getRun(planted);
    expect(row?.parentRunId ?? null).toBeNull();
    expect(row?.metadata?.['parentRunId']).toBeUndefined();
    expect(row?.metadata?.['delegatedBy']).toBeUndefined();
  });

  it('a scheduled job cannot carry the linkage onto the runs it fires (architect A1)', async () => {
    const { a, b } = await sharedWorkspace();
    const aRun = await startRun(a);
    const job = await b.postAs('/host/openwop-app/scheduler/jobs', {
      cronExpr: '0 0 1 1 *', workflowId: 'conformance-noop',
      metadata: { parentRunId: aRun, delegatedBy: 'agent:iris', title: 'Scheduled plant' },
    }, isJobBody);
    expect(job.status, JSON.stringify(job.body)).toBeLessThan(300);
    const jobId = job.body.job?.jobId ?? job.body.jobId ?? '';
    expect(jobId, JSON.stringify(job.body)).not.toBe('');
    // The route itself stripped it (the daemon's filter is the second line, below).
    const stored = await getJob(jobId);
    expect(stored?.metadata?.['parentRunId']).toBeUndefined();
    expect(stored?.metadata?.['delegatedBy']).toBeUndefined();
    const fired = await b.post(`/host/openwop-app/scheduler/jobs/${encodeURIComponent(jobId)}/trigger`);
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    const deck = await a.get(DECK, isDeckBody);
    const parent = findCard(deck.body.deck, aRun);
    expect(parent, 'own run present').toBeTruthy();
    expect(parent?.children ?? []).toEqual([]);
    expect(JSON.stringify(deck.body)).not.toContain('Scheduled plant');
  });

  it('CONTROL: a host-dispatched child (the parent_run_id column) nests under its parent', async () => {
    const { a, ws } = await sharedWorkspace();
    const aRun = await startRun(a);
    await seed({ runId: `td-child-${n++}`, tenantId: ws, parentRunId: aRun, metadata: { delegatedBy: 'agent:a1' } }, new Date().toISOString());
    const deck = await a.get(DECK, isDeckBody);
    const parent = findCard(deck.body.deck, aRun);
    expect(parent?.children.length).toBe(1);
    expect(parent?.children[0]?.status).toBe('delegated');
    // Nested, not ALSO listed as a top-level card.
    expect(topLevelIds(deck.body.deck)).not.toContain(parent?.children[0]?.runId);
  });
});

describe('ADR 0902 D3 — a fork is not delegated work', () => {
  // The shape `POST /runs/{id}:fork` writes (`routes/runs.ts` fork handler): the
  // column `parentRunId` + `forkMode`, `actingUserId` re-stamped to the FORKER,
  // and the RFC 0165 owner stamp copied VERBATIM from the source (§B.4, the
  // identity of record). The deck follows the owner of record — the same answer
  // the home tiles give — and never files the fork as delegated work.
  it('another member\'s fork of my run is never nested as delegated work; it is its owner-of-record\'s own task', async () => {
    const { a, b, ws, aUser, bUser } = await sharedWorkspace();
    const aRun = await startRun(a);
    const fork = `td-fork-${n++}`;
    await seed({ runId: fork, tenantId: ws, parentRunId: aRun, forkMode: 'branch', metadata: { actingUserId: bUser, ...ownerStamp(aUser) } }, new Date().toISOString());
    const deck = await a.get(DECK, isDeckBody);
    expect(findCard(deck.body.deck, aRun)?.children.map((c) => c.runId) ?? []).not.toContain(fork);
    expect(topLevelIds(deck.body.deck)).toContain(fork);
    const bDeck = await b.get(DECK, isDeckBody);
    expect(findCard(bDeck.body.deck, fork), 'the forker is not the owner of record').toBeUndefined();
  });

  it('my own fork is my own top-level task, not a delegated child', async () => {
    const { a, ws, aUser } = await sharedWorkspace();
    const aRun = await startRun(a);
    const fork = `td-ownfork-${n++}`;
    await seed({ runId: fork, tenantId: ws, parentRunId: aRun, forkMode: 'replay', metadata: { actingUserId: aUser, ...ownerStamp(aUser) } }, new Date().toISOString());
    const deck = await a.get(DECK, isDeckBody);
    expect(deck.body.deck.buckets.running.map((c) => c.runId)).toContain(fork);
    expect(findCard(deck.body.deck, aRun)?.children.map((c) => c.runId) ?? []).not.toContain(fork);
  });
});

describe('ADR 0902 D4 — ownership is the run owner, the same rule as the home tiles', () => {
  it('a delegated child\'s own delegated work (a grandchild) is shown under it', async () => {
    const { a, ws } = await sharedWorkspace();
    const aRun = await startRun(a);
    const c1 = `td-c1-${n++}`; const c2 = `td-c2-${n++}`;
    const at = new Date().toISOString();
    await seed({ runId: c1, tenantId: ws, parentRunId: aRun, metadata: {} }, at);
    await seed({ runId: c2, tenantId: ws, parentRunId: c1, metadata: {} }, at);
    const deck = await a.get(DECK, isDeckBody);
    const child = findCard(deck.body.deck, c1);
    expect(child?.children.map((c) => c.runId)).toEqual([c2]);
  });

  it('in my personal workspace a host-fired run with no owner stamp is mine', async () => {
    const c = client();
    const u = await signup(c, 'personal');
    const run = `td-hostfired-${n++}`;
    await seed({ runId: run, tenantId: u.tenantId, metadata: { schedule: { jobId: 'j1' } } }, new Date().toISOString());
    const deck = await c.get(DECK, isDeckBody);
    expect(findCard(deck.body.deck, run)).toBeTruthy();
  });

  it('CONTROL: in a shared workspace another member\'s run is never mine', async () => {
    const { a, b } = await sharedWorkspace();
    const bRun = await startRun(b);
    const deck = await a.get(DECK, isDeckBody);
    expect(findCard(deck.body.deck, bRun)).toBeUndefined();
    const bDeck = await b.get(DECK, isDeckBody);
    expect(findCard(bDeck.body.deck, bRun)).toBeTruthy();
  });
});

describe('ADR 0902 D5 — a bounded deck says it is bounded', () => {
  it('when the scan stops before an owned run, the response says truncated', async () => {
    const { a, ws, aUser, bUser } = await sharedWorkspace();
    const old = `td-old-${n++}`;
    // A's run, older than the whole scan window.
    await seed({ runId: old, tenantId: ws, metadata: { actingUserId: aUser, ...ownerStamp(aUser) } }, '2020-01-01T00:00:00.000Z');
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 1001; i++) {
      await seed({ runId: `td-noise-${n}-${i}`, tenantId: ws, status: 'completed', metadata: { actingUserId: bUser } }, new Date(base + i * 1000).toISOString());
    }
    const deck = await a.get(DECK, isDeckBody);
    expect(deck.status).toBe(200);
    // The owned run is past the window, and the deck must say a window exists.
    expect(findCard(deck.body.deck, old)).toBeUndefined();
    expect(deck.body.deck.truncated).toBe(true);
  });

  it('CONTROL: a small deck is not truncated', async () => {
    const { a } = await sharedWorkspace();
    await startRun(a);
    const deck = await a.get(DECK, isDeckBody);
    expect(deck.body.deck.truncated).toBe(false);
  });
});

describe('ADR 0902 D2 — the service caller (the sub-run dispatcher) keeps its linkage', () => {
  // `dev-token` is the wildcard credential `resolveInternalToken` falls back to in
  // an unenforced deploy — exactly what the HTTP dispatcher presents here.
  const asService = (body: unknown) => fetch(`${BASE}/runs`, {
    method: 'POST', headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('CONTROL: a parent in the same tenant is admitted and the child nests', async () => {
    const { a, ws } = await sharedWorkspace();
    const aRun = await startRun(a);
    const res = await asService({ workflowId: 'conformance-noop', tenantId: ws, inputs: {}, metadata: { parentRunId: aRun, delegatedBy: 'agent:a1' } });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const childBody = parseAs(await res.text(), isRunBody);
    const child = raw(childBody.runId);
    const row = await storage.getRun(child);
    expect(row?.metadata?.['parentRunId']).toBe(aRun);
    expect(row?.metadata?.['delegatedBy']).toBe('agent:a1');
    const deck = await a.get(DECK, isDeckBody);
    expect(findCard(deck.body.deck, aRun)?.children.map((c) => c.runId)).toContain(child);
  });

  it('a parent in ANOTHER tenant is not admitted', async () => {
    const { a } = await sharedWorkspace();
    const aRun = await startRun(a);
    const other = await sharedWorkspace();
    const res = await asService({ workflowId: 'conformance-noop', tenantId: other.ws, inputs: {}, metadata: { parentRunId: aRun, delegatedBy: 'agent:x' } });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const body = parseAs(await res.text(), isRunBody);
    const row = await storage.getRun(raw(body.runId));
    expect(row?.metadata?.['parentRunId']).toBeUndefined();
    expect(row?.metadata?.['delegatedBy']).toBeUndefined();
  });
});

describe('ADR 0902 D2 (architect A1) — a job written before the fix plants nothing', () => {
  it('the schedule daemon does not spread a stored linkage onto the run it fires', async () => {
    const { a, b, ws, bUser } = await sharedWorkspace();
    const aRun = await startRun(a);
    const jobId = `td-legacy-job-${n++}`;
    const reg = await registerJob({ jobId, tenantId: ws, cronExpr: '0 0 1 1 *', workflowId: 'conformance-noop', metadata: { actingUserId: bUser, parentRunId: aRun, delegatedBy: 'agent:iris' } });
    expect(reg.ok).toBe(true);
    const fired = await b.post(`/host/openwop-app/scheduler/jobs/${encodeURIComponent(jobId)}/trigger`);
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    const deck = await a.get(DECK, isDeckBody);
    expect(findCard(deck.body.deck, aRun)?.children ?? []).toEqual([]);
  });
});

describe('ADR 0902 D4 — the chat tool reads the same deck as the route', () => {
  it('in the personal workspace the tool, like the route, shows a host-fired run', async () => {
    const c = client();
    const u = await signup(c, 'tool');
    const run = `td-tool-hostfired-${n++}`;
    await seed({ runId: run, tenantId: u.tenantId, metadata: {} }, new Date().toISOString());
    const out = await createAgentToolProvider({ tenantId: u.tenantId, runId: 'td-tool-run', actingUserId: u.userId, personalTenant: u.tenantId }).executeTool({ name: TASKS_DECK_TOOL_ID, input: {} });
    const { deck } = parseAs(out.content, isDeckBody);
    expect(findCard(deck, run)).toBeTruthy();
    const route = await c.get(DECK, isDeckBody);
    expect(findCard(route.body.deck, run)).toBeTruthy();
  });

  it('CONTROL: in a shared workspace the tool shows the acting member\'s runs only', async () => {
    const { a, b, ws, aUser } = await sharedWorkspace();
    const aRun = await startRun(a);
    const bRun = await startRun(b);
    const out = await createAgentToolProvider({ tenantId: ws, runId: 'td-tool-run2', actingUserId: aUser }).executeTool({ name: TASKS_DECK_TOOL_ID, input: {} });
    const { deck } = parseAs(out.content, isDeckBody);
    expect(findCard(deck, aRun)).toBeTruthy();
    expect(findCard(deck, bRun)).toBeUndefined();
  });
});

describe('ADR 0902 D6 — counts survive the card cap', () => {
  it('a bucket over the cap lists 50 cards and counts them all', async () => {
    const { a, ws, aUser } = await sharedWorkspace();
    const base = Date.UTC(2026, 1, 1);
    for (let i = 0; i < 55; i++) {
      await seed({ runId: `td-done-${n}-${i}`, tenantId: ws, status: 'completed', metadata: { actingUserId: aUser } }, new Date(base + i * 1000).toISOString());
    }
    const deck = await a.get(DECK, isDeckBody);
    expect(deck.body.deck.buckets.completed.length).toBe(50);
    expect(deck.body.deck.counts.completed).toBe(55);
  });
});

describe('ADR 0902 (TD2CD-3) — per-card lookups cost only what is shown', () => {
  it('60 blocked runs read at most the 50 shown cards\' interrupts', async () => {
    const { a, ws, aUser } = await sharedWorkspace();
    const base = Date.UTC(2026, 2, 1);
    for (let i = 0; i < 60; i++) {
      await seed({ runId: `td-blk-${n}-${i}`, tenantId: ws, status: 'waiting-approval', metadata: { actingUserId: aUser } }, new Date(base + i * 1000).toISOString());
    }
    const spy = vi.spyOn(storage, 'listOpenInterrupts');
    try {
      const deck = await a.get(DECK, isDeckBody);
      expect(deck.body.deck.counts.blocked).toBe(60);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(50);
      expect(spy.mock.calls.length, 'the shown blockers are still looked up').toBeGreaterThan(0);
    } finally { spy.mockRestore(); }
  });
});

describe('ADR 0902 D2 ratchet — one linkage key list at every caller-metadata entry', () => {
  it('the POST /runs strip, the scheduler route, the schedule daemon and redrive all read CALLER_LINKAGE_KEYS', () => {
    const SRC = resolve(import.meta.dirname, '..', 'src');
    for (const f of ['host/runDispatch.ts', 'routes/scheduler.ts', 'host/scheduleDaemon.ts', 'routes/runs.ts', 'routes/workflowDebug.ts']) {
      const code = readFileSync(resolve(SRC, f), 'utf8');
      expect(code, f).toMatch(/import \{[^}]*CALLER_LINKAGE_KEYS[^}]*\} from '[./]*(host\/)?runLinkage\.js'/);
      expect(code.split('CALLER_LINKAGE_KEYS').length, `${f} uses it beyond the import`).toBeGreaterThan(2);
    }
  });
});

describe('ADR 0902 (TD2CD-2) — a redrive does not inherit the source\'s delegation', () => {
  it('redriving a failed delegated child makes the redriver\'s own run, not another delegated card', async () => {
    const { a, ws } = await sharedWorkspace();
    const aRun = await startRun(a);
    const child = `td-redrive-src-${n++}`;
    await seed({ runId: child, tenantId: ws, workflowId: 'conformance-noop', status: 'failed', metadata: { parentRunId: aRun, delegatedBy: 'agent:a1' } }, new Date().toISOString());
    const r = await a.postAs('/host/openwop-app/runs/redrive', { runIds: [child] }, isRedriveBody);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const redriveRunId = r.body.results[0]?.redriveRunId;
    expect(redriveRunId, JSON.stringify(r.body)).toBeTruthy();
    const row = await storage.getRun(raw(redriveRunId!));
    expect(row?.metadata?.['parentRunId']).toBeUndefined();
    expect(row?.metadata?.['delegatedBy']).toBeUndefined();
    expect(row?.metadata?.['redriveOf']).toBe(child);
  });
});

describe('ADR 0902 (TD2UX-3/9) — cards read as people would name them', () => {
  it('a run with no title is named after its workflow\'s display name', async () => {
    const c = client();
    await signup(c, 'named');
    const wf = `td-named-wf-${n++}`;
    const created = await c.post('/host/openwop-app/workflows', { workflowId: wf, metadata: { name: 'Weekly pipeline review' }, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'hold' } }], edges: [] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const r = await c.postAs('/runs', { workflowId: wf, inputs: {} }, isRunBody);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const runId = raw(r.body.runId);
    const deck = await c.get(DECK, isDeckBody);
    expect(findCard(deck.body.deck, runId)?.title).toBe('Weekly pipeline review');
  });


  it('a cancelled run is marked cancelled, not just failed', async () => {
    const { a, ws, aUser } = await sharedWorkspace();
    const run = `td-cancel-${n++}`;
    await seed({ runId: run, tenantId: ws, status: 'cancelled', metadata: { actingUserId: aUser } }, new Date().toISOString());
    const deck = await a.get(DECK, isDeckBody);
    const c = findCard(deck.body.deck, run);
    expect(c?.status).toBe('failed');
    expect(c?.cancelled).toBe(true);
  });
});
