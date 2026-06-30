/**
 * Multi-approver / quorum review policies (ADR 0070) — ROUTE-level harness over
 * the AUTHENTICATED path. Proves the vote identity is the session subject (not a
 * client `voter`), eligibility is enforced (ineligible → 403), the durable ledger
 * dedups a reviewer's repeat vote, the /reviews projection surfaces quorum
 * progress, and a second eligible approver tips the gate to resolution.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
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
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `q-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId;
}
async function pollWaiting(c: Client, runId: string): Promise<string> {
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const s = (await c.get(`/v1/runs/${runId}`)).body.status as string;
    if (s.startsWith('waiting') || ['completed', 'failed', 'cancelled'].includes(s)) return s;
  }
  return 'unknown';
}

/** Owner + a same-tenant member; a 2-of-N quorum gate suspended, with both as
 *  eligible approverRefs. Returns the run + interrupt + both clients. */
async function suspendQuorumGate(approverIds: (o: string, m: string) => string[]): Promise<{ owner: Client; member: Client; ownerId: string; memberId: string; runId: string; nodeId: string; interruptId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client();
  const member = client();
  const ownerId = await signup(owner, tenantId);
  const memberId = await signup(member, tenantId);
  const workflowId = `quorum.test.${n++}`;
  await owner.post('/v1/host/openwop-app/workflows', {
    workflowId,
    nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Approve release', requiredApprovals: 2, actions: ['accept', 'reject'], approverRefs: approverIds(ownerId, memberId) } }],
    edges: [],
  });
  const create = await owner.post('/v1/runs', { workflowId });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const runId = create.body.runId;
  expect((await pollWaiting(owner, runId)).startsWith('waiting')).toBe(true);
  const ints = (await owner.get(`/v1/host/openwop-app/runs/${runId}/interrupts`)).body;
  const interruptId = ints.interrupts.find((i: { nodeId: string }) => i.nodeId === 'gate').interruptId;
  return { owner, member, ownerId, memberId, runId, nodeId: 'gate', interruptId };
}

const vote = (c: Client, runId: string, action: string, extra: Record<string, unknown> = {}) =>
  c.post(`/v1/runs/${runId}/interrupts/gate`, { resumeValue: { action, ...extra } });

describe('quorum gate — authenticated vote identity + eligibility', () => {
  it('enforces eligibility: an approver NOT in the gate list is forbidden (403)', async () => {
    // Only the owner is an eligible approver; the member is not.
    const { member, runId } = await suspendQuorumGate((o) => [o]);
    const r = await vote(member, runId, 'accept');
    expect(r.status).toBe(403);
  });

  it('dedups a reviewer’s repeat vote in the durable ledger; a second approver tips quorum', async () => {
    const { owner, member, runId, interruptId } = await suspendQuorumGate((o, m) => [o, m]);

    // Owner votes accept → pending (1 of 2); the /reviews projection shows progress.
    expect((await vote(owner, runId, 'accept')).status).toBe(200);
    expect((await pollWaiting(owner, runId)).startsWith('waiting')).toBe(true);
    const review1 = await owner.get(`/v1/host/openwop-app/reviews/interrupt:${interruptId}`);
    expect(review1.body.policy).toMatchObject({ requiredApprovals: 2, approvals: 1 });

    // Owner votes AGAIN (same reviewer) → durable dedup: still 1 of 2, still waiting.
    await vote(owner, runId, 'accept');
    expect((await pollWaiting(owner, runId)).startsWith('waiting')).toBe(true);
    const review2 = await owner.get(`/v1/host/openwop-app/reviews/interrupt:${interruptId}`);
    expect(review2.body.policy.approvals).toBe(1); // NOT 2 — the repeat vote didn't double-count

    // The member (the SECOND distinct eligible approver) votes → quorum met → resolves.
    expect((await vote(member, runId, 'accept')).status).toBe(200);
    const done = await pollWaiting(owner, runId);
    expect(done.startsWith('waiting')).toBe(false); // gate resolved
  });
});

describe('quorum gate — anon / no-identity callers fail closed (ADR 0070 hardening)', () => {
  // The node route has no per-run owner check, so eligibility is the only
  // authorization on a quorum vote. A caller with NO bound user identity and NO
  // capability token (an auto-minted anon cookie session) must NOT be able to
  // vote — neither on an explicit-approverRefs gate nor on an OPEN gate.
  it('rejects an anonymous caller on an explicit-approverRefs quorum gate (403)', async () => {
    const { ownerId, memberId, runId } = await suspendQuorumGate((o, m) => [o, m]);
    void ownerId; void memberId;
    const anon = client(); // never logs in → auto-minted anon session (no userId)
    const r = await vote(anon, runId, 'accept', { voter: 'forged-approver' });
    expect(r.status).toBe(403);
  });

  it('rejects an anonymous caller on an OPEN (empty-list) quorum gate (403)', async () => {
    // An open gate admits any voter id ON THE CAPABILITY-TOKEN path, but an anon
    // cookie session is not a capability token — it still fails closed.
    const { runId } = await suspendQuorumGate(() => []);
    const anon = client();
    const r = await vote(anon, runId, 'accept', { voter: 'a' });
    expect(r.status).toBe(403);
  });
});

describe('quorum gate — unified rejection semantics (ADR 0070, shared evaluateQuorumTally)', () => {
  // The default rejectionPolicy is 'any' (one reject vetoes) on BOTH the runtime
  // interrupt and the pre-execution approval surfaces — the single source of
  // truth is `evaluateQuorumTally`. This pins the runtime-gate side of that rule.
  it('a single reject on a DEFAULT-policy quorum gate vetoes the gate (run fails)', async () => {
    // suspendQuorumGate sets requiredApprovals:2 with NO rejectionPolicy ⇒ 'any'.
    const { owner, runId } = await suspendQuorumGate((o, m) => [o, m]);
    expect((await vote(owner, runId, 'reject')).status).toBe(200);
    const done = await pollWaiting(owner, runId);
    expect(done).toBe('failed'); // one reject vetoed — not 'waiting', not 'completed'
  });
});
