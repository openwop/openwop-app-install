/**
 * ADR 0882 — CSM security witnesses (feature loop round 2, row 42). Each case
 * states the correct behaviour; the ones marked RED-ON-MAIN failed on
 * `origin/main` `229dd3377` before the fix (P1–P3 were written first, as probes,
 * and proved red there).
 *
 *  D1  the `ctx.features.csm` partition is closed-world and every method is
 *      floored (a Viewer's run cannot write; a non-member's — including an event
 *      binding's removed creator — cannot read);
 *  D2  a computed score names its org; a frozen pre-0882 copy RECORDS why it
 *      stopped instead of scoring;
 *  D3  the owner is a canonical `user:` workspace member; removal unassigns it,
 *      DSAR clears it, and it never rides the run lane;
 *  D4  the CRM task writer takes a company link and only a member assignee, and
 *      a removed member's open tasks are unassigned.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { createAccount, getAccount } from '../src/features/csm/accountsService.js';
import { buildCsmSurface, CSM_SURFACE_READS, CSM_SURFACE_WRITERS } from '../src/features/csm/surface.js';
import { createCompany } from '../src/features/crm/entities/companies.js';
import { createTask, getTask } from '../src/features/crm/entities/tasks.js';
import { eraseSubject } from '../src/host/subjectErasure.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'csm']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return {
    post: (p: string, b?: unknown) => call('POST', p, b),
    get: (p: string) => call('GET', p),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
  };
}

let n = 0;
async function team() {
  const tenantId = `org:a0882p-${Date.now()}-${n++}`;
  const ids: string[] = [];
  const owner = client();
  for (const c of [owner, client(), client()]) {
    const r = await c.post('/host/openwop-app/test/login', { email: `a0882p-${Date.now()}-${n++}@acme.test`, tenantId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids.push((r.body as { user: { userId: string } }).user.userId);
  }
  const [ownerId, editorId, viewerId] = ids as [string, string, string];
  // The editor is ALSO a workspace-root member (assignable as an owner).
  const rootAdd = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(tenantId)}/members`, { displayName: 'Ed Itor', subject: editorId, roles: ['editor'] });
  expect(rootAdd.status, JSON.stringify(rootAdd.body)).toBe(201);
  const editorRootMemberId = (rootAdd.body as { memberId: string }).memberId;
  const orgIds: string[] = [];
  for (const name of ['Acme', 'Beta']) {
    const org = await owner.post('/host/openwop-app/orgs', { name });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    orgIds.push((org.body as { orgId: string }).orgId);
  }
  const [orgA, orgB] = orgIds as [string, string];
  // editor: member of A only; viewer: viewer of A.
  for (const [subject, role] of [[editorId, 'editor'], [viewerId, 'viewer']] as const) {
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgA)}/members`, { displayName: role, subject, roles: [role] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  }
  // an outsider: a real user whose home is a different tenant.
  const outsider = client();
  const o = await outsider.post('/host/openwop-app/test/login', { email: `a0882p-out-${Date.now()}-${n++}@else.test`, tenantId: `org:a0882p-else-${n++}` });
  const outsiderId = (o.body as { user: { userId: string } }).user.userId;
  return { tenantId, orgA, orgB, ownerId, editorId, viewerId, outsiderId, owner, editorRootMemberId };
}

describe('ADR 0882 probes — ctx.features.csm run lane', () => {
  it('P1 a viewer\'s run cannot write health (RED-ON-MAIN)', async () => {
    const t = await team();
    const acct = await createAccount({ tenantId: t.tenantId, name: 'Planted target' });
    const asViewer = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-v', actingUserId: t.viewerId }).csm!;
    await expect(asViewer.setHealth!({ accountId: acct.accountId, healthScore: 3 })).rejects.toMatchObject({ code: 'forbidden_scope' });
    expect((await getAccount(acct.accountId))?.healthScore).toBeUndefined();
  });

  it('P2 a run whose person is not a member cannot read the account book (RED-ON-MAIN)', async () => {
    const t = await team();
    await createAccount({ tenantId: t.tenantId, name: 'Secret ARR', arr: 1_000_000 });
    const asOutsider = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-o', actingUserId: t.outsiderId }).csm!;
    await expect(asOutsider.listAccounts!({})).rejects.toMatchObject({ code: 'forbidden_scope' });
  });

  it('P3 a computed score must be measured in the account\'s own org (RED-ON-MAIN)', async () => {
    const t = await team();
    const { companyId } = await createCompany({ tenantId: t.tenantId, orgId: t.orgB, name: 'Beta Co', createdBy: 'test' });
    const acct = await createAccount({ tenantId: t.tenantId, name: 'Beta account', crmRef: { orgId: t.orgB, companyId } });
    // The editor is in org A only; it measures org A's (empty) deals for B's company.
    const asEditor = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-e', actingUserId: t.editorId }).csm!;
    await expect(asEditor.setHealth!({
      accountId: acct.accountId, orgId: t.orgA, companyId, healthScore: 100, method: 'penalty-sum',
      factors: [{ factor: 'openDeals', weight: 8, value: 0 }, { factor: 'openTasks', weight: 3, value: 0 }],
    })).rejects.toBeTruthy();
    expect((await getAccount(acct.accountId))?.healthComputedAt).toBeUndefined();
  });

  it('control: an editor\'s run writes; a personless system run stays tenant-trusted', async () => {
    const t = await team();
    const acct = await createAccount({ tenantId: t.tenantId, name: 'Real' });
    const asOwner = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-ow', actingUserId: t.ownerId }).csm!;
    expect(await asOwner.setHealth!({ accountId: acct.accountId, healthScore: 40 })).toMatchObject({ account: { healthScore: 40 } });
    const system = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-sys' }).csm!;
    expect(await system.listAccounts!({})).toMatchObject({ accounts: [expect.objectContaining({ name: 'Real' })] });
  });
});

describe('ADR 0882 D1 — the surface partition is closed-world', () => {
  it('every method is classified exactly once', () => {
    const methods = Object.keys(buildCsmSurface({ tenantId: 't-partition' })).sort();
    const classified = [...CSM_SURFACE_READS, ...CSM_SURFACE_WRITERS];
    expect(new Set(classified).size, 'a method is in two sets').toBe(classified.length);
    expect(classified.sort()).toEqual(methods);
  });

  it('an EVENT-bound run is the cause lane: a binding whose creator is not a member reads nothing', async () => {
    const t = await team();
    await createAccount({ tenantId: t.tenantId, name: 'Book' });
    const asCause = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-ev', orgScopeSubject: t.outsiderId }).csm!;
    await expect(asCause.listAccounts!({})).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(asCause.listRenewalsDue!({})).rejects.toMatchObject({ code: 'forbidden_scope' });
  });
});

describe('ADR 0882 D2 — a frozen pre-0882 workflow copy records why it stopped', () => {
  it('a computed set with no org is refused AND the refusal is on the row', async () => {
    const t = await team();
    const { companyId } = await createCompany({ tenantId: t.tenantId, orgId: t.orgA, name: 'Acme Co', createdBy: 'test' });
    const acct = await createAccount({ tenantId: t.tenantId, name: 'Acme', healthScore: 61, crmRef: { orgId: t.orgA, companyId } });
    const asEditor = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-old', actingUserId: t.editorId }).csm!;
    await expect(asEditor.setHealth!({
      accountId: acct.accountId, companyId, healthScore: 100, method: 'penalty-sum',
      factors: [{ factor: 'openDeals', weight: 8, value: 0 }],
    })).rejects.toMatchObject({ code: 'validation_error' });
    const row = await getAccount(acct.accountId);
    expect(row?.healthMeasureFailedReason).toMatch(/predates ADR 0882/);
    expect(row?.healthScore, 'the fabricated score never lands').toBe(61);
    // The same set, naming the right org, is accepted (non-vacuity).
    expect(await asEditor.setHealth!({
      accountId: acct.accountId, companyId, orgId: t.orgA, healthScore: 92, method: 'penalty-sum',
      factors: [{ factor: 'openDeals', weight: 8, value: 1 }],
    })).toMatchObject({ account: { healthScore: 92 } });
  });
});

describe('ADR 0882 D3 — the owner is a workspace member', () => {
  const ACC = '/host/openwop-app/csm/accounts';
  it('assigns a root member; refuses an outsider and a legacy oidc: spelling', async () => {
    const t = await team();
    const ok = await t.owner.post(ACC, { name: 'Owned', ownerUserId: t.editorId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.ownerUserId).toBe(t.editorId);
    const out = await t.owner.post(ACC, { name: 'Nope', ownerUserId: t.outsiderId });
    expect(out.status).toBe(422);
    expect(out.body.details?.reason).toBe('invalid_owner');
    const legacy = await t.owner.post(ACC, { name: 'Legacy', ownerUserId: 'oidc:test-someone' });
    expect(legacy.status).toBe(422);
    const patchBad = await t.owner.patch(`${ACC}/${encodeURIComponent(ok.body.accountId)}`, { ownerUserId: t.outsiderId });
    expect(patchBad.status).toBe(422);
    expect((await getAccount(ok.body.accountId))?.ownerUserId).toBe(t.editorId);
  });

  it('/assignees lists canonical root members and `me`', async () => {
    const t = await team();
    const r = await t.owner.get('/host/openwop-app/csm/assignees');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const subjects = (r.body.assignees as Array<{ subject: string }>).map((a) => a.subject);
    expect(subjects).toContain(t.editorId);
    expect(subjects).toContain(t.ownerId);
    expect(subjects).not.toContain(t.viewerId); // a member of a sub-org only, not of the root
    expect(subjects.every((s) => s.startsWith('user:'))).toBe(true);
    expect(r.body.me).toContain(t.ownerId);
  });

  it('removing the owner from the workspace unassigns their accounts (removed-member residue)', async () => {
    const t = await team();
    const a = await t.owner.post(ACC, { name: 'Will be orphaned', ownerUserId: t.editorId });
    expect(a.status).toBe(201);
    const del = await t.owner.del(`/host/openwop-app/orgs/${encodeURIComponent(t.tenantId)}/members/${encodeURIComponent(t.editorRootMemberId)}`);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    expect((await getAccount(a.body.accountId))?.ownerUserId).toBeUndefined();
  });

  it('a DSAR clears the owner', async () => {
    const t = await team();
    const acct = await createAccount({ tenantId: t.tenantId, name: 'Erase me', ownerUserId: t.editorId });
    await eraseSubject(t.tenantId, t.editorId);
    expect((await getAccount(acct.accountId))?.ownerUserId).toBeUndefined();
  });

  it('the owner id never rides the run lane (read outputs are recorded in the event log)', async () => {
    const t = await team();
    const acct = await createAccount({ tenantId: t.tenantId, name: 'Private owner', ownerUserId: t.editorId });
    const asOwner = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-own', actingUserId: t.ownerId }).csm!;
    const one = await asOwner.getAccount!({ accountId: acct.accountId }) as { account: Record<string, unknown> };
    expect(one.account).not.toHaveProperty('ownerUserId');
    const all = await asOwner.listAccounts!({}) as { accounts: Array<Record<string, unknown>> };
    expect(all.accounts.every((a) => !('ownerUserId' in a))).toBe(true);
  });
});

describe('ADR 0882 D4 — the CRM task writer', () => {
  it('takes a company link and refuses a non-member assignee', async () => {
    const t = await team();
    const { companyId } = await createCompany({ tenantId: t.tenantId, orgId: t.orgA, name: 'Linked Co', createdBy: 'test' });
    const asEditor = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-crm', actingUserId: t.editorId }).crm!;
    const ok = await asEditor.createTask!({ orgId: t.orgA, title: 'Linked', companyId, assignee: t.editorId }) as { task: { companyId?: string; assignee?: string } };
    expect(ok.task.companyId).toBe(companyId);
    expect(ok.task.assignee).toBe(t.editorId);
    await expect(asEditor.createTask!({ orgId: t.orgA, title: 'Bad', assignee: t.outsiderId })).rejects.toMatchObject({ code: 'validation_error', details: { reason: 'invalid_assignee' } });
    await expect(asEditor.createTask!({ orgId: t.orgA, title: 'Ghost co', companyId: 'cmp:does-not-exist' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a removed member\'s OPEN tasks are unassigned and a DSAR clears any task assignee', async () => {
    const t = await team();
    const validators = { validateDeal: async () => true, validateCompany: async () => true, validateContact: async () => true };
    const open = await createTask({ tenantId: t.tenantId, orgId: t.orgA, title: 'open', assignee: t.editorId, createdBy: 'test', validators });
    const done = await createTask({ tenantId: t.tenantId, orgId: t.orgA, title: 'done', status: 'done', assignee: t.editorId, createdBy: 'test', validators });
    const del = await t.owner.del(`/host/openwop-app/orgs/${encodeURIComponent(t.tenantId)}/members/${encodeURIComponent(t.editorRootMemberId)}`);
    expect(del.status).toBe(204);
    expect((await getTask(t.tenantId, t.orgA, open.taskId))?.assignee).toBeUndefined();
    expect((await getTask(t.tenantId, t.orgA, done.taskId))?.assignee, 'history is kept').toBe(t.editorId);
    await eraseSubject(t.tenantId, t.editorId);
    expect((await getTask(t.tenantId, t.orgA, done.taskId))?.assignee).toBeUndefined();
  });
});
