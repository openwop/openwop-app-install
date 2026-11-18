/**
 * ADR 1140 (#5951) — a run's request is addressed only to people who can open
 * the run.
 *
 * Since ADR 1121 a run stamped for a client is read only by that client's people
 * (and the tenant-level grants). The interrupt notification still addressed every
 * named approver, so a member of another client got an "Action needed" card whose
 * run answered `run_not_found`. Now a named approver who fails the floor is not
 * asked, the run's operators get one notice that the step names someone who
 * cannot open it, and if nobody named can open it the request goes to the
 * operators instead of nobody.
 *
 * Driven in a shared workspace with two client orgs over HTTP (the floor is the
 * run door's); the notification is emitted through the production
 * `emitInterruptNotification`. Red when: the filter in `notify.ts` is removed (the
 * other client's approver is addressed), or `runUserReader` stops consulting the
 * client stamp, or a check that throws escapes `splitRunReaders` (the whole
 * request is then silenced by `emitInterruptNotification`'s best-effort catch).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { InterruptRecord, NotificationRecord } from '../src/types.js';
import { emitInterruptNotification } from '../src/notifications/notify.js';
import { __setRunUserReaderForTest, runUserReader } from '../src/host/runClientAccess.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let server: http.Server;
let BASE = '';
let n = 0;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = await res.text();
    let out: unknown;
    try { out = text ? JSON.parse(text) : undefined; } catch { out = text; }
    return { status: res.status, body: out as T };
  };
  return { get: <T = unknown>(p: string) => call<T>('GET', p), post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
type Client = ReturnType<typeof client>;
const enc = encodeURIComponent;
const raw = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
const OPS = 'openwop-app.campaignOps';

async function signup(c: Client): Promise<string> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `req-floor-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId;
}

async function agency() {
  const owner = client();
  const ownerId = await signup(owner);
  const ws = (await owner.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: `Agency-${n++}` })).body.workspaceId;
  expect((await owner.post(`/host/openwop-app/workspaces/${enc(ws)}/switch`)).status).toBe(200);
  const org = async (name: string): Promise<string> => (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name })).body.orgId;
  const orgA = await org('Client A');
  const orgB = await org('Client B');
  /** A root viewer who is also a viewer in `clientOrg`. */
  const join = async (clientOrg: string): Promise<{ c: Client; userId: string }> => {
    const c = client();
    const userId = await signup(c);
    for (const [orgId, roles] of [[ws, ['viewer']], [clientOrg, ['viewer']]] as const) {
      // #5945 PR-2 — members are seeded through the auth test seam (a user-id subject is refused on the real route).
      const add = await owner.post(`/host/openwop-app/test/orgs/${enc(orgId)}/members`, { displayName: 'P', subject: userId, roles });
      expect(add.status, JSON.stringify(add.body)).toBe(201);
    }
    expect((await c.post(`/host/openwop-app/workspaces/${enc(ws)}/switch`)).status).toBe(200);
    return { c, userId };
  };
  const run = async (clientOrg?: string): Promise<{ id: string; wire: string }> => {
    const r = await owner.post<{ runId: string }>('/runs', { workflowId: 'conformance-noop', inputs: {} });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const id = raw(r.body.runId);
    if (clientOrg) {
      const row = await storage.getRun(id);
      await storage.updateRun(id, { metadata: { ...(row?.metadata ?? {}), [OPS]: { orgId: clientOrg } } });
    }
    return { id, wire: r.body.runId };
  };
  return { ws, ownerId, orgA, orgB, join, run };
}

let seq = 0;
async function request(tenantId: string, runId: string, approverRefs: string[]): Promise<NotificationRecord[]> {
  const interruptId = `int-1140-${seq++}`;
  const interrupt: InterruptRecord = { interruptId, runId, nodeId: 'gate', kind: 'approval', token: 'tok', data: { approverRefs, prompt: 'Approve the brief' }, createdAt: new Date().toISOString() };
  await emitInterruptNotification(storage, interrupt);
  const all = await storage.listNotifications({ tenantId, limit: 500 });
  return all.filter((r) => r.runId === runId);
}
const asked = (rows: NotificationRecord[]) => rows.filter((r) => r.interruptId !== undefined);
const notices = (rows: NotificationRecord[]) => rows.filter((r) => r.type === 'openwop-app.workflow.approver-unreadable');

describe('ADR 1140 — a run\'s request reaches only people who can open the run', () => {
  it('asks the approver in the run\'s client, not the one in another client, and tells the operators once', async () => {
    const a = await agency();
    const inA = await a.join(a.orgA);
    const inB = await a.join(a.orgB);
    const r = await a.run(a.orgA);
    // The floor this mirrors: B cannot open the run.
    expect((await inA.c.get(`/runs/${enc(r.wire)}`)).status).toBe(200);
    expect((await inB.c.get(`/runs/${enc(r.wire)}`)).status).toBe(404);

    const rows = await request(a.ws, r.id, [inA.userId, inB.userId]);
    expect(asked(rows).map((x) => x.recipientUserId)).toEqual([inA.userId]);
    // The operators (the ADR 0710 audience, one row per admin) get the notice, and
    // the approver who cannot open the run is never one of them.
    const n1 = notices(rows);
    expect(n1.map((x) => x.recipientUserId)).toEqual([a.ownerId]);
    expect(n1[0]!.interruptId, 'a notice, not a request: it carries no interrupt').toBeUndefined();
    expect(n1[0]!.message).toMatch(/1 named approver cannot open this run/);
  });

  it('an unstamped run asks everyone named, with no notice (unchanged)', async () => {
    const a = await agency();
    const inA = await a.join(a.orgA);
    const inB = await a.join(a.orgB);
    const r = await a.run();
    const rows = await request(a.ws, r.id, [inA.userId, inB.userId]);
    expect(asked(rows).map((x) => x.recipientUserId).sort()).toEqual([inA.userId, inB.userId].sort());
    expect(notices(rows)).toHaveLength(0);
  });

  it('when nobody named can open the run, the request goes to the operators, not to nobody', async () => {
    const a = await agency();
    const inB = await a.join(a.orgB);
    const r = await a.run(a.orgA);
    const rows = await request(a.ws, r.id, [inB.userId]);
    expect(asked(rows).map((x) => x.recipientUserId), 'the operator audience (ADR 0710), not the named approver').toEqual([a.ownerId]);
    expect(notices(rows).map((x) => x.recipientUserId)).toEqual([a.ownerId]);
  });

  it('a tenant admin named on a client run is asked (the tenant-level grant)', async () => {
    const a = await agency();
    const r = await a.run(a.orgA);
    const rows = await request(a.ws, r.id, [a.ownerId]);
    expect(asked(rows).map((x) => x.recipientUserId)).toEqual([a.ownerId]);
    expect(notices(rows)).toHaveLength(0);
  });

  it('a check that throws for one approver drops only that one: the other is asked and the operators are told', async () => {
    const a = await agency();
    const inA = await a.join(a.orgA);
    const flaky = await a.join(a.orgA);
    const r = await a.run(a.orgA);
    __setRunUserReaderForTest((run) => {
      const real = runUserReader(run);
      return async (userId) => {
        if (userId === flaky.userId) throw new Error('storage unavailable');
        return real(userId);
      };
    });
    try {
      const rows = await request(a.ws, r.id, [inA.userId, flaky.userId]);
      expect(asked(rows).map((x) => x.recipientUserId)).toEqual([inA.userId]);
      expect(notices(rows).map((x) => x.recipientUserId)).toEqual([a.ownerId]);
    } finally {
      __setRunUserReaderForTest(undefined);
    }
  });
});
