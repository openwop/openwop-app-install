/**
 * Approval delegations (ADR 0198) — HTTP authz + end-to-end quorum: the
 * /approval-delegations CRUD (self-service; non-self forbidden; owner-only
 * revoke; tenant isolation; superadmin-gated ?all) and a real 2-of-N quorum
 * gate where a delegate's vote counts AS the principal (no double-count).
 * The service-layer semantics live in approval-delegations.unit.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;

let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
async function signup(c: Client, tenantId: string): Promise<string> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `dlg-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId;
}

const DLG = '/v1/host/openwop-app/approval-delegations';

describe('approval-delegation routes — authz through HTTP', () => {
  it('self-service create + list + owner-only revoke; forging fromSubject is forbidden', async () => {
    const tenantId = `org:dlg-${Date.now()}-${n++}`;
    const alice = client();
    const bob = client();
    const aliceId = await signup(alice, tenantId);
    const bobId = await signup(bob, tenantId);

    // Alice delegates to Bob (fromSubject defaults to the caller).
    const created = await alice.post(DLG, { toSubject: bobId, startsAt: iso(-HOUR), endsAt: iso(HOUR), reason: 'PTO' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.delegation.fromSubject).toBe(aliceId);

    // Bob cannot create a delegation FROM Alice.
    const forged = await bob.post(DLG, { fromSubject: aliceId, toSubject: bobId, startsAt: iso(-HOUR), endsAt: iso(HOUR) });
    expect(forged.status).toBe(403);

    // Both parties see it in their list.
    expect((await alice.get(DLG)).body.delegations).toHaveLength(1);
    expect((await bob.get(DLG)).body.delegations).toHaveLength(1);

    // Bob (the delegate, not the owner) cannot revoke; Alice can.
    const id = created.body.delegation.delegationId;
    expect((await bob.post(`${DLG}/${id}/revoke`)).status).toBe(403);
    expect((await alice.post(`${DLG}/${id}/revoke`)).status).toBe(200);
  });

  it('tenant isolation: a delegation is invisible and unrevokable cross-tenant', async () => {
    const tA = `org:dlg-a-${Date.now()}-${n++}`;
    const tB = `org:dlg-b-${Date.now()}-${n++}`;
    const a = client();
    const b = client();
    await signup(a, tA);
    await signup(b, tB);
    const created = await a.post(DLG, { toSubject: 'u:other', startsAt: iso(-HOUR), endsAt: iso(HOUR) });
    expect(created.status).toBe(201);
    expect((await b.get(DLG)).body.delegations).toHaveLength(0);
    expect((await b.post(`${DLG}/${created.body.delegation.delegationId}/revoke`)).status).toBe(404);
  });

  it('?all=1 is superadmin-gated', async () => {
    const c = client();
    await signup(c, `org:dlg-${Date.now()}-${n++}`);
    expect((await c.get(`${DLG}?all=1`)).status).toBe(403);
  });
});

describe('quorum gate + delegation — a delegate votes AS the principal (end-to-end)', () => {
  async function suspendQuorumGate(): Promise<{ owner: Client; member: Client; third: Client; ownerId: string; memberId: string; thirdId: string; runId: string }> {
    const tenantId = `org:dlgq-${Date.now()}-${n++}`;
    const owner = client();
    const member = client();
    const third = client();
    const ownerId = await signup(owner, tenantId);
    const memberId = await signup(member, tenantId);
    const thirdId = await signup(third, tenantId);
    const workflowId = `dlgq.test.${n++}`;
    await owner.post('/v1/host/openwop-app/workflows', {
      workflowId,
      nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Approve', requiredApprovals: 2, actions: ['accept', 'reject'], approverRefs: [ownerId, memberId] } }],
      edges: [],
    });
    const create = await owner.post('/v1/runs', { workflowId });
    expect(create.status).toBe(201);
    const runId = create.body.runId;
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const s = (await owner.get(`/v1/runs/${runId}`)).body.status as string;
      if (s.startsWith('waiting')) break;
    }
    return { owner, member, third, ownerId, memberId, thirdId, runId };
  }
  const vote = (c: Client, runId: string, extra: Record<string, unknown> = {}) =>
    c.post(`/v1/runs/${runId}/interrupts/gate`, { resumeValue: { action: 'accept', ...extra } });
  const status = async (c: Client, runId: string) => (await c.get(`/v1/runs/${runId}`)).body.status as string;

  it('principal votes + their delegate votes → still 1 of 2 (no double-count); a distinct approver tips it', async () => {
    const { owner, member, third, memberId, thirdId, runId } = await suspendQuorumGate();

    // Member delegates their approvals to the (non-listed) third user.
    const dlg = await member.post(DLG, { toSubject: thirdId, startsAt: iso(-HOUR), endsAt: iso(HOUR) });
    expect(dlg.status).toBe(201);

    // The member votes, then their delegate votes: SAME consumed identity →
    // durable dedup → still waiting on 1 of 2.
    expect((await vote(member, runId)).status).toBe(200);
    expect((await vote(third, runId)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect((await status(member, runId)).startsWith('waiting')).toBe(true);
    void memberId;

    // The owner (a distinct identity) votes → 2 of 2 → resolves.
    expect((await vote(owner, runId)).status).toBe(200);
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (!(await status(owner, runId)).startsWith('waiting')) break;
    }
    expect((await status(owner, runId)).startsWith('waiting')).toBe(false);
  });

  it('a delegate of an eligible principal can vote where a stranger cannot', async () => {
    const { member, third, thirdId, runId } = await suspendQuorumGate();
    // Before any delegation: the third user is not eligible.
    expect((await vote(third, runId)).status).toBe(403);
    // After the member delegates to them: eligible, counted as the member.
    expect((await member.post(DLG, { toSubject: thirdId, startsAt: iso(-HOUR), endsAt: iso(HOUR) })).status).toBe(201);
    expect((await vote(third, runId)).status).toBe(200);
  });
});
