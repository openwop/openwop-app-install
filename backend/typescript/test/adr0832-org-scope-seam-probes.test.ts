/**
 * ADR 0832 — the org-membership floor at the `featureSurfaces` seam.
 *
 * ~30 feature surfaces take `orgId` from node args and hand it straight to their
 * service, which keys on tenant + org and never asks whether the RUN's person is
 * in that org. The HTTP doors for the same data all gate on `requireOrgScope`, so
 * a member of org A who is not in org B gets a 403 at `/crm/orgs/B/…` and, before
 * this ADR, org B's rows from `ctx.features.crm.listCompanies({ orgId: B })`.
 *
 * Every leg goes through `buildFeatureSurfaces` — the seam the executor binds
 * into `ctx.features` — never a surface builder directly, because the fix lives
 * at the seam and a builder-level probe would not see it.
 *
 * Each refusal leg sits beside an allowed leg (same org, an owner, a system run,
 * a tenant-scoped KB namespace), so a floor that blocks everybody fails here too.
 * Allowed legs assert the method's real result shape, so a refusal or an empty
 * answer cannot pass for an allowed one.
 *
 * Tracker TST-BOS-1. Sabotage-witnessed (w62): red when the seam stops calling
 * the org floor, the causing-member lane is dropped, the tenant-scoped KB
 * namespaces lose their pass, a method's stricter scope is ignored, the method
 * re-reads the caller's args instead of the floor's copy, a non-string orgId is
 * accepted, or ctx.knowledge stops forwarding the causing member.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces, type FeatureSurface } from '../src/host/featureSurfaces.js';
import { buildHostSurfaceBundle, type BundleScope } from '../src/host/inMemorySurfaces.js';
import { createCollection, ingestDocument } from '../src/features/kb/kbService.js';
import { createOrg } from '../src/host/accessControlService.js';

let BASE: string;
let server: http.Server;
let n = 0;

const PROBED = ['crm', 'cms', 'documents', 'email', 'commerce', 'forms', 'kb', 'campaign-brief', 'campaign-intel', 'kicktodo-organizations'] as const;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', ...PROBED]) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The response fields this file reads (test/login and orgs). */
interface Body { user?: { userId: string }; orgId?: string }
interface Res { status: number; body: Body }
function client(): { post: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  return {
    post: async (path, body) => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      // Narrowed to the fields this file reads (a non-JSON body reads as `{}`).
      const parsed = (await res.json().catch(() => ({}))) as Body;
      return { status: res.status, body: parsed };
    },
  };
}

const H = '/host/openwop-app';
const SECRET = 'Finance-only acquisition target';

/** One tenant, two orgs. The OWNER created both; the MEMBER is an `editor` of
 *  org A only. Org B holds one CRM company, one CMS draft and one document. */
async function fixture() {
  const tenantId = `org:seam832-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId: string = (await owner.post(`${H}/test/login`, { email: `s832-o-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const member = client();
  const memberId: string = (await member.post(`${H}/test/login`, { email: `s832-m-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const orgA: string = (await owner.post(`${H}/orgs`, { name: 'Everyone' })).body.orgId ?? '';
  const orgB: string = (await owner.post(`${H}/orgs`, { name: 'Finance' })).body.orgId ?? '';
  expect(ownerId && memberId && orgA && orgB, 'fixture: both users and both orgs exist').toBeTruthy();
  const add = await owner.post(`${H}/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'M', subject: memberId, roles: ['editor'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);

  const asOwner = surfaces({ tenantId, runId: 'seed', actingUserId: ownerId });
  await asOwner.crm!.createCompany!({ orgId: orgB, name: SECRET, companyId: 'cmp:secret' });
  const page = await asOwner.cms!.createDraftPage!({ orgId: orgB, title: SECRET });
  const doc = await asOwner.documents!.createDocument!({ orgId: orgB, title: SECRET, kind: 'memo', format: 'markdown' }) as { document?: { documentId: string }; documentId?: string };
  return { tenantId, ownerId, memberId, orgA, orgB, pageId: (page as { pageId: string }).pageId, doc };
}

function surfaces(scope: BundleScope): Record<string, FeatureSurface> {
  return buildFeatureSurfaces(scope);
}

// Exact codes, not a regex that accepts either: a floor that 404'd every org
// would otherwise pass every org-B leg (org B EXISTS, so its refusal is a 403).
const FORBIDDEN = { code: 'forbidden_scope' };
const NOT_FOUND = { code: 'not_found' };
const leaks = (v: unknown): boolean => JSON.stringify(v).includes(SECRET);

describe('the seam refuses a run whose person is not in the named org', () => {
  // One leg per surface, so each is witnessed RED on its own (a sequence of
  // awaits would stop at the first and hide the rest).
  type Leg = [string, string, (f: Awaited<ReturnType<typeof fixture>>) => Record<string, unknown>];
  const READS: Leg[] = [
    ['crm', 'listCompanies', (f) => ({ orgId: f.orgB })],
    ['cms', 'getDraftPage', (f) => ({ orgId: f.orgB, pageId: f.pageId })],
    ['documents', 'listDocuments', (f) => ({ orgId: f.orgB })],
    ['email', 'listTemplates', (f) => ({ orgId: f.orgB })],
    ['commerce', 'listOrders', (f) => ({ orgId: f.orgB })],
    ['forms', 'listForms', (f) => ({ orgId: f.orgB })],
    // ADR 0857 D6 — analytics rides the floor in `gate()` with no per-method call.
    ['analytics', 'summary', (f) => ({ orgId: f.orgB })],
    ['analytics', 'events', (f) => ({ orgId: f.orgB })],
  ];
  const WRITES: Leg[] = [
    ['cms', 'createDraftPage', (f) => ({ orgId: f.orgB, title: 'planted' })],
    ['crm', 'createCompany', (f) => ({ orgId: f.orgB, name: 'planted' })],
    ['documents', 'createDocument', (f) => ({ orgId: f.orgB, title: 'planted', kind: 'memo', format: 'markdown' })],
  ];
  it.each([...READS.map((l) => ['read', ...l] as const), ...WRITES.map((l) => ['write', ...l] as const)])('%s %s.%s in org B', async (_kind, surface, method, args) => {
    const f = await fixture();
    const s = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.memberId });
    await expect(s[surface]![method]!(args(f))).rejects.toMatchObject(FORBIDDEN);
  });

  it('a pseudo-org is not a pass on a surface that never declared it', async () => {
    const f = await fixture();
    const s = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.memberId });
    await expect(s.crm!.listCompanies!({ orgId: '_team' })).rejects.toMatchObject(NOT_FOUND);
    await expect(s.crm!.listCompanies!({ orgId: 'org-in-no-tenant' })).rejects.toMatchObject(NOT_FOUND);
  });

  it('R8 — a run a member caused but is not acting for reads as that member', async () => {
    const f = await fixture();
    const s = surfaces({ tenantId: f.tenantId, runId: 'r1', orgScopeSubject: f.memberId });
    await expect(s.crm!.listCompanies!({ orgId: f.orgB })).rejects.toMatchObject(FORBIDDEN);
    // …and the member's own org still answers.
    await expect(s.crm!.listCompanies!({ orgId: f.orgA })).resolves.toMatchObject({ companies: expect.any(Array) });
  });
});

describe('R8 — knowledge reads in a run a member caused (a channel turn)', () => {
  it('ctx.knowledge drops the orgs the causing member cannot read; a system run is unchanged', async () => {
    const f = await fixture();
    const c = await createCollection(f.tenantId, f.orgB, f.ownerId, { name: 'Finance' });
    await ingestDocument(f.tenantId, f.orgB, f.ownerId, c.collectionId, { title: 'Plan', text: `${SECRET}: drawer nine.` });
    const q = { query: 'acquisition target drawer nine', resultLimit: 20 };
    const caused = await buildHostSurfaceBundle({ tenantId: f.tenantId, runId: 'r', orgScopeSubject: f.memberId }).knowledge!.retrieve(q);
    expect(leaks(caused)).toBe(false);
    const system = await buildHostSurfaceBundle({ tenantId: f.tenantId, runId: 'r' }).knowledge!.retrieve(q);
    expect(leaks(system), 'positive control: the secret is retrievable at all').toBe(true);
  });
});

describe('R8 in a shared personal workspace (grade M1)', () => {
  it('a causing member is answered by membership, not by the tenant being personal-shaped', async () => {
    const tenantId = `user:seam832-${Date.now()}-${n++}`;
    const org = await createOrg({ tenantId, createdBy: 'test', name: 'Private', ownerSubject: 'user:owner-832' });
    const caused = surfaces({ tenantId, runId: 'r', orgScopeSubject: 'user:poster-832' });
    await expect(caused.crm!.listCompanies!({ orgId: org.orgId })).rejects.toMatchObject(FORBIDDEN);
    // …while the owner's own channel turn still reads it.
    const owner = surfaces({ tenantId, runId: 'r', orgScopeSubject: 'user:owner-832' });
    await expect(owner.crm!.listCompanies!({ orgId: org.orgId })).resolves.toMatchObject({ companies: expect.any(Array) });
  });
});

describe('what the floor refuses beyond a foreign org', () => {
  it('an orgId that is present but not a string (a coercing surface would read it as an org)', async () => {
    const f = await fixture();
    const s = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.memberId });
    // `campaign-intel` runs `String(args.orgId ?? '')`: ['B'] would become 'B'.
    await expect(s['campaign-intel']!.anomalies!({ orgId: [f.orgB] })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(s['campaign-intel']!.anomalies!({ orgId: { toString: () => f.orgB } })).rejects.toMatchObject({ code: 'validation_error' });
    // '' and null name NO org, like an absent key: the floor does not check them
    // (an empty org reading the whole tenant is residue S-A, pinned separately).
    await expect(s.crm!.listCompanies!({ orgId: '' })).resolves.toMatchObject({ companies: expect.any(Array) });
    await expect(s.crm!.listCompanies!({ orgId: null })).resolves.toMatchObject({ companies: expect.any(Array) });
  });

  it('a method whose door needs more than membership asks that scope (kicktodo-organizations.report)', async () => {
    const f = await fixture();
    const member = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.memberId });
    await expect(member['kicktodo-organizations']!.report!({ orgId: f.orgA })).rejects.toMatchObject(FORBIDDEN);
    await expect(member['kicktodo-organizations']!.catalog!({ orgId: f.orgA })).resolves.toHaveProperty('catalog');
    const owner = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.ownerId });
    await expect(owner['kicktodo-organizations']!.report!({ orgId: f.orgA })).resolves.toHaveProperty('cells');
  });

  it('the floor and the method read the same orgId (an accessor cannot answer each differently)', async () => {
    const f = await fixture();
    const s = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.memberId });
    let reads = 0;
    const args = { get orgId() { reads += 1; return reads === 1 ? f.orgA : f.orgB; } };
    const out = await s.crm!.listCompanies!(args);
    expect(leaks(out)).toBe(false);
  });
});

describe('positive controls (a floor that blocks everyone is a wall)', () => {
  it('the same run reads and writes its own org', async () => {
    const f = await fixture();
    const s = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.memberId });
    await expect(s.crm!.listCompanies!({ orgId: f.orgA })).resolves.toMatchObject({ companies: expect.any(Array) });
    await expect(s.documents!.listDocuments!({ orgId: f.orgA })).resolves.toMatchObject({ documents: expect.any(Array) });
    await expect(s.cms!.createDraftPage!({ orgId: f.orgA, title: 'mine' })).resolves.toMatchObject({ status: 'draft' });
  });

  it('the owner reads org B', async () => {
    const f = await fixture();
    const s = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.ownerId });
    expect(leaks(await s.crm!.listCompanies!({ orgId: f.orgB }))).toBe(true);
  });

  it('a system run (no person at all) keeps the tenant-trusted model', async () => {
    const f = await fixture();
    const s = surfaces({ tenantId: f.tenantId, runId: 'r1' });
    expect(leaks(await s.crm!.listCompanies!({ orgId: f.orgB }))).toBe(true);
  });

  it('a method with no orgId arg is not touched by the floor', async () => {
    const f = await fixture();
    const s = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.memberId });
    await expect(s['campaign-brief']!.listBriefs!({})).resolves.toMatchObject({ briefs: expect.any(Array) });
  });

  it('KB keeps its tenant-scoped namespaces readable by name (`_team`, `_kickbot`)', async () => {
    const f = await fixture();
    const s = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.memberId });
    await expect(s.kb!.listCollections!({ orgId: '_team' })).resolves.toMatchObject({ collections: expect.any(Array) });
    await expect(s.kb!.listCollections!({ orgId: '_kickbot' })).resolves.toMatchObject({ collections: expect.any(Array) });
    await expect(s.kb!.listCollections!({ orgId: '_unlisted' })).rejects.toMatchObject(NOT_FOUND);
  });
});
