/**
 * ADR 0776 P2 — `GET /host/openwop-app/chat/sessions/running`: which of the
 * CALLER's conversations have a run in flight.
 *
 * Pins, through the HTTP boundary (route order + authz are only visible there):
 *  - the route is reachable (not shadowed by `/chat/sessions/:sessionId`);
 *  - pending + running count; completed, and the always-open conversation run
 *    itself, do not (else every open chat would read "Running");
 *  - another member's conversation is never reported (ids never leave);
 *  - no acting user ⇒ empty, never tenant-wide.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): the conversation run counted
 * (`8fw2g3-rbc-convrun`), `pending` dropped (`-rbc-pending`), the per-user
 * visibility filter removed (`-rbc-visibility`), the tenant scope removed
 * (`-rbc-tenant`), and the no-user guard removed (`-rbc-nouser`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { listRunningConversations, type RunningConversation } from '../src/host/runningByConversation.js';
import type { RunRecord, RunStatus } from '../src/types.js';

/** The route's body (`routes/chatSessions.ts` → `listRunningConversations`). */
interface RunningBody { conversations: RunningConversation[]; truncated: boolean }

let BASE: string;
let server: http.Server;
let storage: Storage;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
async function login(tenantId: string): Promise<Call> {
  let cookie = '';
  const call: Call = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  const r = await call('POST', '/host/openwop-app/test/login', { email: `rbc-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return call;
}

const S = '/host/openwop-app/chat/sessions';
async function seed(tenantId: string, runId: string, workflowId: string, status: RunStatus, chatSessionId: string): Promise<void> {
  const now = new Date().toISOString();
  const run: RunRecord = { runId, workflowId, tenantId, status, inputs: null, metadata: { chatSessionId }, configurable: {}, createdAt: now, updatedAt: now };
  await storage.insertRun(run);
}
async function running(call: Call): Promise<RunningBody> {
  const r = await call('GET', `${S}/running`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as RunningBody;
}

describe('chat/sessions/running (ADR 0776 P2)', () => {
  it('reports only the caller\'s own conversations with pending/running work, never the conversation run itself', async () => {
    const tenantId = `org:rbc-${Date.now()}-${n++}`;
    const alice = await login(tenantId);
    const bob = await login(tenantId);
    const a = `sa-${n++}`; const b = `sb-${n++}`; const quiet = `sq-${n++}`;
    for (const [who, id] of [[alice, a], [alice, quiet], [bob, b]] as const) {
      expect((await who('POST', S, { sessionId: id, title: id })).status).toBe(201);
    }
    await seed(tenantId, `r1-${n}`, 'wf.launch', 'running', a);
    await seed(tenantId, `r2-${n}`, 'wf.summary', 'pending', a);
    await seed(tenantId, `r3-${n}`, 'openwop-app.conversation', 'running', quiet); // always open — not "Running"
    await seed(tenantId, `r4-${n}`, 'wf.done', 'completed', quiet);
    await seed(tenantId, `r5-${n}`, 'wf.bob', 'running', b);

    expect(await running(alice)).toEqual({ conversations: [{ conversationId: a, runs: 2 }], truncated: false });
    expect(await running(bob)).toEqual({ conversations: [{ conversationId: b, runs: 1 }], truncated: false });
  });

  it('is tenant-scoped: another workspace sees nothing of this one', async () => {
    const tenantId = `org:rbc-${Date.now()}-${n++}`;
    const alice = await login(tenantId);
    const id = `sx-${n++}`;
    expect((await alice('POST', S, { sessionId: id, title: id })).status).toBe(201);
    await seed(tenantId, `rx-${n}`, 'wf.x', 'running', id);
    // Positive control: the owner sees it, so the other workspace's empty list is the scope.
    expect(await running(alice)).toEqual({ conversations: [{ conversationId: id, runs: 1 }], truncated: false });
    const other = await login(`org:rbc-other-${Date.now()}-${n++}`);
    expect(await running(other)).toEqual({ conversations: [], truncated: false });
  });

  it('with no acting user it is empty, never tenant-wide', async () => {
    const tenantId = `org:rbc-${Date.now()}-${n++}`;
    await seed(tenantId, `ry-${n}`, 'wf.y', 'running', `sy-${n}`);
    expect(await listRunningConversations(storage, tenantId, undefined)).toEqual({ conversations: [], truncated: false });
  });
});
