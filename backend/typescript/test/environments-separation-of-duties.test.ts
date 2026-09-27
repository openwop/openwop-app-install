/**
 * ADR 0732 — a promotion approval the PROPOSER can sign is not an approval.
 *
 * `requireApprovalForPromotion` queues an `environment-promotion` approval and
 * applies the move only after a `host:members:manage` member decides. Before this
 * ADR the decide path never compared the decider to the proposer — and no proposer
 * was recorded at all — so one admin could queue a prod promotion and approve it.
 * The gate was ON and gated nothing that proposer could not clear alone.
 *
 * D3's exit is load-bearing, not politeness: `createWorkspace` mints a SINGLE
 * `owner` member, so a one-admin workspace is the DEFAULT state. An unconditional
 * distinct-approver rule would brick promotion for every new tenant that enables
 * the gate — a gate with no exit, which is its own defect.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember, deleteMember, listMembers, hasDistinctScopeHolder } from '../src/host/accessControlService.js';
import { createEnvironmentPromotionApproval } from '../src/host/approvalService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const B = '/v1/host/openwop-app/environments';
const APPR = '/v1/host/openwop-app/approvals';
let server: http.Server;
let ORIGIN = '';
let n = 0;

interface C {
  userId: string;
  get: (p: string) => Promise<{ status: number; body: any }>;
  post: (p: string, b?: unknown) => Promise<{ status: number; body: any }>;
  patch: (p: string, b?: unknown) => Promise<{ status: number; body: any }>;
  del: (p: string) => Promise<{ status: number; body: any }>;
}

async function loginTo(tenantId: string, who: string): Promise<C> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  const r = await call('POST', '/v1/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return {
    userId: r.body.user.userId,
    get: (p) => call('GET', p), post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p),
  };
}

/**
 * A workspace with the gate ON, a pinned dev snapshot, and EXACTLY `admins`
 * members holding `host:members:manage`.
 *
 * `createWorkspace` mints a founder `owner` member, which IS an eligible approver
 * — the first draft of this helper forgot that and "one admin" silently meant two,
 * so the sole-admin exit leg failed for a reason that had nothing to do with the
 * code under test. The founder is removed here so the count is what it claims.
 */
async function workspace(admins: number): Promise<{ ws: string; actors: C[] }> {
  const founderSubject = `oidc:sod-founder-${n++}`;
  const w = await createWorkspace({ name: `sod-${n++}`, ownerSubject: founderSubject });
  const ws = w.orgId ?? w.tenantId;
  const actors: C[] = [];
  for (let i = 0; i < admins; i += 1) {
    const c = await loginTo(ws, `admin${i}`);
    // Actor 0 takes `owner` so the founder can then be removed: a workspace must
    // always retain an owner (`deleteMember` refuses the last one), which is
    // itself why "a one-admin workspace" means "the owner, alone".
    await createMember({
      orgId: ws, tenantId: ws, displayName: `Admin ${i}`, subject: c.userId,
      roles: [i === 0 ? 'owner' : 'admin'],
    });
    actors.push(c);
  }
  const founder = (await listMembers(ws, ws)).find((m) => m.subject === founderSubject);
  expect(founder, 'the founder member must exist to be removed').toBeTruthy();
  expect(await deleteMember(founder!.memberId)).toBe(true);
  const a = actors[0]!;
  expect([200, 201]).toContain((await a.post(`${B}/ensure-chain`)).status);
  const snap = await a.post(`${B}/snapshots`, { sourceEnv: 'dev' });
  const hash = snap.body.hash as string;
  expect([200, 201]).toContain((await a.post(`${B}/rollback`, { env: 'dev', snapshotHash: hash })).status);
  expect((await a.patch(`${B}/settings`, { requireApprovalForPromotion: true })).status).toBe(200);
  return { ws, actors };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['environments', 'users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0732 D1 — the proposer is recorded', () => {
  it('a queued promotion carries requestedBy = the promoting member', async () => {
    const { actors } = await workspace(1);
    const gated = await actors[0]!.post(`${B}/promote`, { fromEnv: 'dev' });
    expect(gated.status).toBe(202);
    const inbox = await actors[0]!.get(`${APPR}?status=pending`);
    const row = (inbox.body.items as Array<{ approvalId: string; envPromotion?: { requestedBy?: string } }>)
      .find((a) => a.approvalId === gated.body.approval.approvalId);
    expect(row, 'the approval must render in the shared inbox').toBeTruthy();
    expect(row?.envPromotion?.requestedBy, 'the proposer must be recorded').toBe(actors[0]!.userId);
  });
});

describe('ADR 0732 D2/D3 — self-approval is refused ONLY when a distinct approver exists', () => {
  it('TWO admins: the proposer cannot approve their own promotion, and the approval stays pending', async () => {
    const { actors } = await workspace(2);
    const [a, b] = actors as [C, C];
    const gated = await a.post(`${B}/promote`, { fromEnv: 'dev' });
    expect(gated.status).toBe(202);
    const id = gated.body.approval.approvalId as string;

    const self = await a.post(`${APPR}/${id}/claim`);
    expect(self.status, `proposer self-approved: ${JSON.stringify(self.body)}`).toBe(403);
    expect(JSON.stringify(self.body)).toContain('separation-of-duties');

    // ...and the refusal did NOT consume the approval.
    const still = await a.get(`${APPR}?status=pending`);
    expect((still.body.items as Array<{ approvalId: string }>).some((x) => x.approvalId === id)).toBe(true);

    // The EXIT: the other admin can decide, and the pointer moves.
    const other = await b.post(`${APPR}/${id}/claim`);
    expect(other.status, `distinct approver refused: ${JSON.stringify(other.body)}`).toBe(200);
    expect(other.body.status).toBe('approved');
    const envs = (await a.get(`${B}`)).body.environments as Array<{ name: string; currentSnapshot: string | null }>;
    expect(envs.find((e) => e.name === 'staging')?.currentSnapshot, 'the approved move must apply').toBeTruthy();
  });

  it('ONE admin: the sole eligible approver MAY decide (a gate with no exit would brick a new workspace)', async () => {
    const { actors } = await workspace(1);
    const a = actors[0]!;
    const gated = await a.post(`${B}/promote`, { fromEnv: 'dev' });
    expect(gated.status).toBe(202);
    const claim = await a.post(`${APPR}/${gated.body.approval.approvalId}/claim`);
    expect(claim.status, `a sole admin was bricked: ${JSON.stringify(claim.body)}`).toBe(200);
    expect(claim.body.status).toBe('approved');
  });

  it('the predicate itself: a distinct holder is seen only when one exists', async () => {
    const { ws: one, actors: a1 } = await workspace(1);
    expect(await hasDistinctScopeHolder(one, 'host:members:manage', a1[0]!.userId)).toBe(false);
    const { ws: two, actors: a2 } = await workspace(2);
    expect(await hasDistinctScopeHolder(two, 'host:members:manage', a2[0]!.userId)).toBe(true);
    // ...and a VIEWER does not count as an eligible approver.
    const viewer = await loginTo(one, 'viewer');
    await createMember({ orgId: one, tenantId: one, displayName: 'V', subject: viewer.userId, roles: ['viewer'] });
    expect(await hasDistinctScopeHolder(one, 'host:members:manage', a1[0]!.userId)).toBe(false);
  });
});

describe('ENVC-6 — EVERY mutating environments door refuses a non-admin member', () => {
  it('a viewer is 403 at all eight admin doors; an admin passes the same doors', async () => {
    const { ws, actors } = await workspace(1);
    const viewer = await loginTo(ws, 'viewer-doors');
    await createMember({ orgId: ws, tenantId: ws, displayName: 'VD', subject: viewer.userId, roles: ['viewer'] });
    const doors: Array<[string, () => Promise<{ status: number; body: any }>]> = [
      ['create', () => viewer.post(`${B}`, { name: `e${n++}` })],
      ['ensure-chain', () => viewer.post(`${B}/ensure-chain`)],
      ['protection', () => viewer.patch(`${B}/dev/protection`, { protection: 'open' })],
      ['settings', () => viewer.patch(`${B}/settings`, { requireApprovalForPromotion: false })],
      ['snapshot', () => viewer.post(`${B}/snapshots`, { sourceEnv: 'dev' })],
      ['promote', () => viewer.post(`${B}/promote`, { fromEnv: 'dev' })],
      ['rollback', () => viewer.post(`${B}/rollback`, { env: 'dev', snapshotHash: 'x'.repeat(64) })],
      ['apply', () => viewer.post(`${B}/apply`, { snapshotHash: 'x'.repeat(64) })],
    ];
    for (const [name, call] of doors) {
      const r = await call();
      expect(r.status, `${name} let a viewer through: ${JSON.stringify(r.body)}`).toBe(403);
    }
    // Non-vacuity: the READ doors are open to the SAME viewer, so the 403s above
    // are the admin gate and not a blanket refusal of this caller. `preview` is a
    // `workspace:read` door by design (`routes.ts:185`) — it belongs here, not in
    // the admin list, which is why the first draft of this leg mis-filed it.
    expect((await viewer.get(`${B}`)).status).toBe(200);
    expect((await viewer.get(`${B}/snapshots`)).status).toBe(200);
    const prev = await viewer.post(`${B}/preview`, { fromEnv: 'dev', toEnv: 'staging' });
    expect(prev.status, `preview is a read door: ${JSON.stringify(prev.body)}`).not.toBe(403);

    // The POSITIVE control this leg is named for: an ADMIN passes the same admin
    // doors, so the eight 403s above are the RBAC gate and not a broken surface.
    // (tsc caught that this assertion was missing — the leg promised it in its own
    // title and `actors` sat unused, which is what an unread binding usually means.)
    const admin = actors[0]!;
    expect((await admin.patch(`${B}/dev/protection`, { protection: 'open' })).status).toBe(200);
    expect([200, 201]).toContain((await admin.post(`${B}/snapshots`, { sourceEnv: 'dev' })).status);
  });
});

describe('ADR 0732 D5 — a pre-ADR row (no proposer) still decides, loudly', () => {
  it('an approval minted WITHOUT requestedBy is decidable by anyone eligible (bounded fail-open)', async () => {
    const { ws, actors } = await workspace(2);
    const [a] = actors as [C, C];
    // Mint the legacy shape directly: no `requestedBy`, exactly as rows created
    // before D1. Refusing these would strand promotions queued under the old
    // contract; the code logs `environment_promotion_proposer_unknown` instead.
    const legacy = await createEnvironmentPromotionApproval({
      tenantId: ws,
      toEnv: 'staging',
      fromEnv: 'dev',
      snapshotHash: ((await a.post(`${B}/snapshots`, { sourceEnv: 'dev' })).body as { hash: string }).hash,
      proposal: 'legacy row',
    });
    expect(legacy.envPromotion?.requestedBy, 'the legacy shape has no proposer').toBeUndefined();
    const decided = await a.post(`${APPR}/${legacy.approvalId}/claim`);
    expect(decided.status, `a legacy row was stranded: ${JSON.stringify(decided.body)}`).toBe(200);
    expect(decided.body.status).toBe('approved');
  });
});
