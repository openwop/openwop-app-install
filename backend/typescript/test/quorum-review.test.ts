/**
 * Multi-approver / quorum review policies (ADR 0070) — ROUTE-level harness over
 * the AUTHENTICATED path. Proves the vote identity is the session subject (not a
 * client `voter`), eligibility is enforced (ineligible → 403), the durable ledger
 * dedups a reviewer's repeat vote, the /reviews projection surfaces quorum
 * progress, and a second eligible approver tips the gate to resolution.
 *
 * DOUBLE GUARD on eligibility: `assertEligibleApprover` in `routes/interrupts.ts`
 * refuses an ineligible session voter, and `consumeVoteIdentity`
 * (`host/approverResolution.ts`) refuses the same voter again with the SAME
 * message — so removing the route's check alone still 403s (8fw1g3-qr-elig,
 * vacuous in round 1). The two copies differ only in `details`: the route's
 * carries the `interruptId`. The case pins that detail, so the route's copy is
 * load-bearing (8fw1g3-qr-elig-r2), and the shared resolver both copies read is
 * probed directly (8fw1g3-qr-elig-shared-r2).
 *
 * Also sabotage-witnessed: the ledger dedup key (qr-dedup), the veto threshold
 * (qr-veto) and the accept threshold (qr-accept).
 *
 * HONEST CEILING — `pollWaiting` is a 20 ms real-time poll of the run status:
 * the run has no settle hook a test can await. A "still waiting" read right
 * after a vote can therefore pass before the vote is processed; the
 * load-bearing assertions are the `/reviews` approval COUNTS, which are written
 * synchronously by the vote request itself.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { bareRunId } from './support/bareRunId.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';
import { toWireRunId } from '../src/host/v2Ids.js';

let BASE: string;
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

interface Res<T> { status: number; body: T }
interface Client { get: <T>(p: string) => Promise<Res<T>>; post: <T>(p: string, b?: unknown) => Promise<Res<T>> }
interface ErrBody { error: string; message: string; details?: Record<string, unknown> }
interface ReviewBody { policy: { requiredApprovals: number; approvals: number } }
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

/** An anonymous SESSION, bootstrapped the way the SPA does it (the vendor
 *  `/users/me` route still mints). ADR 0750 major-1 extension: a request with no
 *  credential at all is refused 401 before the tenant/eligibility gates this
 *  file witnesses, so the anon caller must hold a real session. */
async function anonClient(): Promise<Client> {
  const c = client();
  await c.get('/host/openwop-app/users/me');
  return c;
}

let n = 0;
async function signup(c: Client, tenantId: string): Promise<string> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `q-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId;
}
async function pollWaiting(c: Client, runId: string): Promise<string> {
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const s = (await c.get<{ status: string }>(`/runs/${runId}`)).body.status;
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
  await owner.post('/host/openwop-app/workflows', {
    workflowId,
    nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Approve release', requiredApprovals: 2, actions: ['accept', 'reject'], approverRefs: approverIds(ownerId, memberId) } }],
    edges: [],
  });
  const create = await owner.post<{ runId: string }>('/runs', { workflowId });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const runId = create.body.runId;
  expect((await pollWaiting(owner, runId)).startsWith('waiting')).toBe(true);
  const ints = (await owner.get<{ interrupts: Array<{ nodeId: string; interruptId: string }> }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body;
  const gate = ints.interrupts.find((i) => i.nodeId === 'gate');
  if (!gate) throw new Error('setup: no interrupt for the gate node');
  const interruptId = gate.interruptId;
  return { owner, member, ownerId, memberId, runId, nodeId: 'gate', interruptId };
}

/** MEASURED at 7321e3612: a repeat vote by the same reviewer is ACCEPTED (200)
 *  and deduped in the ledger — not refused. */
const REPEAT_VOTE_STATUS = 200;
const vote = (c: Client, runId: string, action: string, extra: Record<string, unknown> = {}) =>
  c.post<ErrBody>(`/runs/${runId}/interrupts/gate`, { resumeValue: { action, ...extra } });

describe('quorum gate — authenticated vote identity + eligibility', () => {
  it('enforces eligibility: an approver NOT in the gate list is forbidden (403)', async () => {
    // Only the owner is an eligible approver; the member is not.
    const { owner, member, runId, interruptId } = await suspendQuorumGate((o) => [o]);
    const r = await vote(member, runId, 'accept');
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    // The eligibility refusal itself (a scope 403 would carry another message),
    // answered by the ROUTE's copy — the only one that names the interrupt.
    expect(r.body.message).toBe('You are not an eligible approver for this gate.');
    // (The route reports the interrupt in its WIRE form, which differs from the
    // listing's id, so the presence of the field is what tells the copies apart:
    // `consumeVoteIdentity`'s copy carries empty details.)
    expect(typeof r.body.details?.interruptId).toBe('string');
    expect(String(r.body.details?.interruptId).length).toBeGreaterThan(0);
    // And the refused vote counted for nothing.
    const review = await owner.get<ReviewBody>(`/host/openwop-app/reviews/interrupt:${interruptId}`);
    expect(review.body.policy).toMatchObject({ requiredApprovals: 2, approvals: 0 });
  });

  it('dedups a reviewer’s repeat vote in the durable ledger; a second approver tips quorum', async () => {
    const { owner, member, runId, interruptId } = await suspendQuorumGate((o, m) => [o, m]);

    // Owner votes accept → pending (1 of 2); the /reviews projection shows progress.
    expect((await vote(owner, runId, 'accept')).status).toBe(200);
    expect((await pollWaiting(owner, runId)).startsWith('waiting')).toBe(true);
    const review1 = await owner.get<ReviewBody>(`/host/openwop-app/reviews/interrupt:${interruptId}`);
    expect(review1.body.policy).toMatchObject({ requiredApprovals: 2, approvals: 1 });

    // Owner votes AGAIN (same reviewer) → durable dedup: still 1 of 2, still waiting.
    const repeat = await vote(owner, runId, 'accept');
    expect(repeat.status, JSON.stringify(repeat.body)).toBe(REPEAT_VOTE_STATUS);
    expect((await pollWaiting(owner, runId)).startsWith('waiting')).toBe(true);
    const review2 = await owner.get<ReviewBody>(`/host/openwop-app/reviews/interrupt:${interruptId}`);
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
  it('rejects an anonymous caller on an explicit-approverRefs quorum gate', async () => {
    const { ownerId, memberId, runId } = await suspendQuorumGate((o, m) => [o, m]);
    void ownerId; void memberId;
    const anon = await anonClient(); // never logs in → an anon session in its OWN fresh tenant
    const r = await vote(anon, runId, 'accept', { voter: 'forged-approver' });
    // Fails closed. As of the 2026-07 vuln-scan H1 fix, the node-resume route is
    // tenant-owner-gated (loadOwnedRun): a cross-tenant anon session is rejected at
    // the tenant layer (404 run_not_found, no existence oracle) BEFORE it can reach
    // the quorum-eligibility check — a stronger rejection than the prior 403. The
    // same-tenant quorum-eligibility 403 path is covered by the member tests below.
    // ADR 0812 P2b — under major 2 the id is tenant-BOUND, so the refusal lands one
    // layer earlier still: `identity.md` §5 `403 id_tenant_mismatch`, before any lookup.
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('id_tenant_mismatch');
  });

  it('ADR 0812 P2b — a foreign run id RE-BOUND to the caller\'s own tenant still meets the tenant gate (H1)', async () => {
    // Under major 2 the §5 segment check refuses a foreign tenant segment first, which
    // would leave the tenant gates behind it unexercised. The attack that reaches them
    // binds the victim's opaque id to the ATTACKER's tenant: that passes the segment
    // check, so a tenant gate behind it must answer — 404, no existence oracle.
    // MEASURED: with `loadOwnedRun`'s tenant comparison disabled this still answers 404,
    // so a second gate also holds. The leg witnesses the refusal, not which gate gives it.
    const { owner, runId } = await suspendQuorumGate(() => []);
    // POSITIVE CONTROL: the SAME construction from the owner's own tenant reaches the
    // run (a vote is not a 404), so the 404 below is the tenant gate — not an id this
    // test built wrong.
    const mine = (await owner.get<{ active: string }>('/host/openwop-app/me/workspaces')).body;
    const ownerBound = projectBoundId(toWireRunId(bareRunId(runId), mine.active));
    expect((await owner.get(`/runs/${ownerBound}`)).status, 'the construction must resolve for the owner').toBe(200);
    const anon = await anonClient();
    const { active } = (await anon.get<{ active: string }>('/host/openwop-app/me/workspaces')).body;
    const selfBound = projectBoundId(toWireRunId(bareRunId(runId), active));
    const r = await vote(anon, selfBound, 'accept', { voter: 'a' });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(r.body.message, 'a route miss would pass this vacuously').not.toBe('No route matches this request.');
  });

  it('rejects an anonymous caller on an OPEN (empty-list) quorum gate', async () => {
    // An open gate admits any voter id ON THE CAPABILITY-TOKEN path, but an anon
    // cookie session is not a capability token — it still fails closed (tenant gate, H1).
    const { runId } = await suspendQuorumGate(() => []);
    const anon = await anonClient();
    const r = await vote(anon, runId, 'accept', { voter: 'a' });
    // Major 2: the bound id's tenant is not the anon caller's (`identity.md` §5).
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('id_tenant_mismatch');
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
