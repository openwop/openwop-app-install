/**
 * ADR 0899 — a declared approver ACL binds the voter on every decide lane
 * (host residue `ISWF-23`).
 *
 * Every probe drives the REAL route over HTTP. Each refusal is paired with an
 * acceptance by the legitimate approver on the same lane, so a lane that refuses
 * everyone cannot pass for a lane that binds.
 *
 *  D1  the capability lane (the RFC 0093 token route, the emailed confirm page) admitted
 *      an ACL'd SINGLE-approver gate on any eligible body `voter` with no proof: the
 *      voter-binding HMAC was checked only when `requiredApprovals > 1`. Any Editor
 *      handed the token by the listing could resolve the gate AS the named approver.
 *  D2  the token route is a public path, so a cookie gives it no identity: a signed-in
 *      impostor is still just a token holder, and needs the approver's signature.
 *  D3  a gate with NO ACL stays open on every lane (documented default).
 *
 * @see docs/adr/0899-interrupt-voter-binding-every-lane.md
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createOrg, createMember, createGroup } from '../src/host/accessControlService.js';
import { executeRun } from '../src/executor/executor.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { __awaitRunResumeChainForTests } from '../src/routes/interrupts.js';
import { signVoterBinding } from '../src/host/interruptVoterBinding.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';
import { getSetCookies } from './headerCookies.js';

let BASE = '';
let server: http.Server;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- app.locals is untyped Express state
let locals: { storage: any; hostSuite: any };

const WF = { acl: 'wf.adr0899.acl-single', open: 'wf.adr0899.open-single' } as const;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0899', serviceVersion: '0.0.1', enableConsoleTracer: false });
  locals = (app as unknown as { locals: typeof locals }).locals;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  registerHostWorkflow(gateWorkflow(WF.open, {}));
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function gateWorkflow(workflowId: string, acl: Record<string, unknown>): WorkflowDefinition {
  return {
    workflowId, name: workflowId, version: '1.0.0',
    nodes: [
      { nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Ship it?', actions: ['accept', 'reject'], ...acl } },
      { nodeId: 'after', typeId: 'core.noop', config: {} },
    ],
    edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'after', triggerRule: 'all_success' }],
  } as unknown as WorkflowDefinition;
}

let n = 0;
interface Person { userId: string; cookie: string }
async function login(tenantId: string): Promise<Person> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `ivb899-${Date.now()}-${n++}@acme.test`, tenantId }) });
  let cookie = '';
  for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
  const userId = ((await res.json()) as { user: { userId: string } }).user.userId;
  return { userId, cookie };
}

/** A shared tenant with two Editors: the named approver and a peer (the impostor). */
async function team(): Promise<{ tenantId: string; orgId: string; approver: Person; peer: Person; approverMemberId: string }> {
  const tenantId = `org:ivb899-${Date.now()}-${n++}`;
  const orgId = `ivb899-o-${n++}`;
  const approver = await login(tenantId);
  const peer = await login(tenantId);
  await createOrg({ tenantId, createdBy: 'test', name: 'O', orgId, ownerSubject: 'user:ivb899-owner' });
  const approverMember = await createMember({ tenantId, orgId, displayName: 'approver', subject: approver.userId, roles: ['editor'] });
  await createMember({ tenantId, orgId, displayName: 'peer', subject: peer.userId, roles: ['editor'] });
  return { tenantId, orgId, approver, peer, approverMemberId: approverMember.memberId };
}

/** A run suspended on its gate. `aclFor` names the gate's sole approver, or is the
 *  gate's whole ACL (a group gate, say); absent ⇒ an open gate. */
async function suspended(tenantId: string, aclFor?: string | Record<string, unknown>, metadata: Record<string, unknown> = {}): Promise<{ runId: string; interruptId: string; token: string }> {
  let workflowId: string = WF.open;
  if (aclFor) {
    workflowId = `${WF.acl}.${n++}`;
    registerHostWorkflow(gateWorkflow(workflowId, typeof aclFor === 'string' ? { approverRefs: [aclFor] } : aclFor));
  }
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-adr0899-${Math.random().toString(36).slice(2)}`, workflowId, tenantId,
    status: 'pending', inputs: {}, metadata, configurable: {}, createdAt: now, updatedAt: now,
  };
  await locals.storage.insertRun(run);
  const def = (await locals.hostSuite.workflowCatalog.getWorkflow(workflowId))!.definition;
  expect((await executeRun(locals.storage, run, def)).status.startsWith('waiting')).toBe(true);
  const [open] = await locals.storage.listOpenInterrupts(run.runId);
  return { runId: run.runId, interruptId: open!.interruptId, token: open!.token };
}

async function post(path: string, body: unknown, cookie?: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

async function postForm(path: string, fields: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  return { status: res.status, text: await res.text() };
}

async function isResolved(runId: string, interruptId: string): Promise<boolean> {
  await __awaitRunResumeChainForTests(runId);
  return Boolean((await locals.storage.getInterrupt(interruptId))?.resolvedAt);
}

describe('ADR 0899 D1 — the token route proves the voter on an ACL\'d single-approver gate', () => {
  it('a peer posting voter=<approver> with NO signature is refused, and the gate stays open (was: 2xx)', async () => {
    const t = await team();
    const g = await suspended(t.tenantId, t.approver.userId);
    const res = await post(`/interrupts/${encodeURIComponent(g.token)}`, { resumeValue: { action: 'accept', voter: t.approver.userId } });
    expect(res.status, res.text).toBe(403);
    expect(await isResolved(g.runId, g.interruptId), 'a refused impostor must not resolve the gate').toBe(false);
  });

  it('a forged signature is refused', async () => {
    const t = await team();
    const g = await suspended(t.tenantId, t.approver.userId);
    const res = await post(`/interrupts/${encodeURIComponent(g.token)}`, { resumeValue: { action: 'accept', voter: t.approver.userId, voterSig: 'not-a-signature' } });
    expect(res.status, res.text).toBe(403);
    expect(await isResolved(g.runId, g.interruptId)).toBe(false);
  });

  it("a signature minted for the PEER cannot be spent as the approver's", async () => {
    const t = await team();
    const g = await suspended(t.tenantId, t.approver.userId);
    const res = await post(`/interrupts/${encodeURIComponent(g.token)}`, { resumeValue: { action: 'accept', voter: t.approver.userId, voterSig: signVoterBinding(g.token, t.peer.userId) } });
    expect(res.status, res.text).toBe(403);
    expect(await isResolved(g.runId, g.interruptId)).toBe(false);
  });

  it("control: the approver's own signed binding is ACCEPTED and resolves the gate", async () => {
    const t = await team();
    const g = await suspended(t.tenantId, t.approver.userId);
    const res = await post(`/interrupts/${encodeURIComponent(g.token)}`, { resumeValue: { action: 'accept', voter: t.approver.userId, voterSig: signVoterBinding(g.token, t.approver.userId) } });
    expect(res.status, res.text).toBeLessThan(300);
    expect(await isResolved(g.runId, g.interruptId)).toBe(true);
  });

  it('control: a voterless token resolve of an ACL\'d gate is refused (unchanged)', async () => {
    const t = await team();
    const g = await suspended(t.tenantId, t.approver.userId);
    const res = await post(`/interrupts/${encodeURIComponent(g.token)}`, { resumeValue: { action: 'accept' } });
    expect(res.status, res.text).toBe(403);
    expect(await isResolved(g.runId, g.interruptId)).toBe(false);
  });
  it('a GROUP-only single-approver gate: an ELIGIBLE member unsigned is refused, signed is accepted', async () => {
    // The ACL may name no subject at all (groups / roles); the binding must not
    // hang off `approverRefs` being non-empty.
    const t = await team();
    const grp = await createGroup({ tenantId: t.tenantId, orgId: t.orgId, name: 'ivb899-approvers', memberIds: [t.approverMemberId] });
    const g = await suspended(t.tenantId, { approverGroupRefs: [grp.groupId] }, { approverOrgId: t.orgId });
    const unsigned = await post(`/interrupts/${encodeURIComponent(g.token)}`, { resumeValue: { action: 'accept', voter: t.approver.userId } });
    expect(unsigned.status, unsigned.text).toBe(403);
    expect(unsigned.text).toMatch(/signed per-approver link/);
    expect(await isResolved(g.runId, g.interruptId)).toBe(false);
    const signed = await post(`/interrupts/${encodeURIComponent(g.token)}`, { resumeValue: { action: 'accept', voter: t.approver.userId, voterSig: signVoterBinding(g.token, t.approver.userId) } });
    expect(signed.status, signed.text).toBeLessThan(300);
    expect(await isResolved(g.runId, g.interruptId)).toBe(true);
  });

  it('the legacy `approversList` spelling binds the same way', async () => {
    const t = await team();
    const g = await suspended(t.tenantId, { approversList: [t.approver.userId] });
    const unsigned = await post(`/interrupts/${encodeURIComponent(g.token)}`, { resumeValue: { action: 'accept', voter: t.approver.userId } });
    expect(unsigned.status, unsigned.text).toBe(403);
    expect(await isResolved(g.runId, g.interruptId)).toBe(false);
    const signed = await post(`/interrupts/${encodeURIComponent(g.token)}`, { resumeValue: { action: 'accept', voter: t.approver.userId, voterSig: signVoterBinding(g.token, t.approver.userId) } });
    expect(signed.status, signed.text).toBeLessThan(300);
    expect(await isResolved(g.runId, g.interruptId)).toBe(true);
  });
});

describe('ADR 0899 D2 — the token route is identity-free: a cookie does not make `voter` count', () => {
  it("the PEER's session cookie plus voter=<approver> is still refused (was: 2xx)", async () => {
    const t = await team();
    const g = await suspended(t.tenantId, t.approver.userId);
    const res = await post(`/interrupts/${encodeURIComponent(g.token)}`, { resumeValue: { action: 'accept', voter: t.approver.userId } }, t.peer.cookie);
    expect(res.status, res.text).toBe(403);
    expect(await isResolved(g.runId, g.interruptId)).toBe(false);
  });

  it("even the APPROVER's own cookie does not stand in for the signature on this lane", async () => {
    // The route never reads the session (a public path), so the approver decides
    // signed in on a session lane, or through their emailed link.
    const t = await team();
    const g = await suspended(t.tenantId, t.approver.userId);
    const res = await post(`/interrupts/${encodeURIComponent(g.token)}`, { resumeValue: { action: 'accept', voter: t.approver.userId } }, t.approver.cookie);
    expect(res.status, res.text).toBe(403);
    expect(await isResolved(g.runId, g.interruptId)).toBe(false);
  });
});

describe('ADR 0899 D1 — the emailed confirm page', () => {
  it("the approver's signed emailed link is ACCEPTED", async () => {
    const t = await team();
    const g = await suspended(t.tenantId, t.approver.userId);
    const res = await postForm('/host/openwop-app/interrupt-action', { token: g.token, action: 'approve', voter: t.approver.userId, sig: signVoterBinding(g.token, t.approver.userId) });
    expect(res.status, res.text).toBe(200);
    expect(await isResolved(g.runId, g.interruptId)).toBe(true);
  });

  it('the same form with no voter is refused for an ACL\'d gate', async () => {
    const t = await team();
    const g = await suspended(t.tenantId, t.approver.userId);
    const res = await postForm('/host/openwop-app/interrupt-action', { token: g.token, action: 'approve' });
    expect(res.status, res.text).toBe(403);
    expect(await isResolved(g.runId, g.interruptId)).toBe(false);
  });
});

describe('ADR 0899 — the session lanes keep binding (controls on the same gate shape)', () => {
  it('node route: the peer posting voter=<approver> is refused; the approver is accepted', async () => {
    const t = await team();
    const g = await suspended(t.tenantId, t.approver.userId);
    const peer = await post(`/runs/${encodeURIComponent(`${t.tenantId}/${g.runId}`)}/interrupts/gate`, { resumeValue: { action: 'accept', voter: t.approver.userId } }, t.peer.cookie);
    expect(peer.status, peer.text).toBe(403);
    expect(await isResolved(g.runId, g.interruptId)).toBe(false);
    const own = await post(`/runs/${encodeURIComponent(`${t.tenantId}/${g.runId}`)}/interrupts/gate`, { resumeValue: { action: 'accept' } }, t.approver.cookie);
    expect(own.status, own.text).toBeLessThan(300);
    expect(await isResolved(g.runId, g.interruptId)).toBe(true);
  });

  it('/reviews: the peer is refused; the approver is accepted', async () => {
    const t = await team();
    const g = await suspended(t.tenantId, t.approver.userId);
    const reviewPath = `/host/openwop-app/reviews/${encodeURIComponent(`interrupt:${g.interruptId}`)}/actions/accept`;
    const peer = await post(reviewPath, { value: { voter: t.approver.userId } }, t.peer.cookie);
    expect(peer.status, peer.text).toBe(403);
    expect(await isResolved(g.runId, g.interruptId)).toBe(false);
    const own = await post(reviewPath, {}, t.approver.cookie);
    expect(own.status, own.text).toBeLessThan(300);
    expect(await isResolved(g.runId, g.interruptId)).toBe(true);
  });
});

describe('ADR 0899 D3 — a gate with NO ACL stays open (the documented default)', () => {
  it('the token route resolves an open gate on the token alone', async () => {
    const t = await team();
    const g = await suspended(t.tenantId);
    const res = await post(`/interrupts/${encodeURIComponent(g.token)}`, { resumeValue: { action: 'accept' } });
    expect(res.status, res.text).toBeLessThan(300);
    expect(await isResolved(g.runId, g.interruptId)).toBe(true);
  });

  it('any Editor resolves an open gate on the node route', async () => {
    const t = await team();
    const g = await suspended(t.tenantId);
    const res = await post(`/runs/${encodeURIComponent(`${t.tenantId}/${g.runId}`)}/interrupts/gate`, { resumeValue: { action: 'accept' } }, t.peer.cookie);
    expect(res.status, res.text).toBeLessThan(300);
    expect(await isResolved(g.runId, g.interruptId)).toBe(true);
  });

  it('any Editor resolves an open gate through /reviews', async () => {
    const t = await team();
    const g = await suspended(t.tenantId);
    const res = await post(`/host/openwop-app/reviews/${encodeURIComponent(`interrupt:${g.interruptId}`)}/actions/accept`, {}, t.peer.cookie);
    expect(res.status, res.text).toBeLessThan(300);
    expect(await isResolved(g.runId, g.interruptId)).toBe(true);
  });
});
