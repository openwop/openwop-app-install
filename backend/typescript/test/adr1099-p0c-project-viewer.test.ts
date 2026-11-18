/**
 * ADR 1099 P0c — a kind's projection is made FOR a viewer, and a kind may refuse
 * a recipient at mint.
 *
 * A grant names one resource id, so vendor B's grant can never project vendor A's
 * purchase order (pinned first, below). What the seam could not do: show each
 * vendor only ITS lines of a resource several vendors share (`project` had no
 * viewer), and refuse a member granting one vendor's PO to another (nothing ran
 * at mint). Now `project` gets `{collaboratorId, grantId}` on every collaborator
 * read; a kind that relies on it declares `requiresViewer`, and the host never
 * calls its projection without one (a host path with no collaborator gets
 * nothing, never the whole PO); and `mayGrantTo` refuses the wrong recipient.
 *
 * Sabotage notes (each reds a case below):
 *  - `guardedProject` ignoring `requiresViewer` reds "no viewer, nothing";
 *  - `projectForGrant` passing no viewer reds "each vendor sees only its own lines";
 *  - the collaborator read route projecting through `grantResourceKind(...).project`
 *    without a viewer reds the same case;
 *  - `grantAccess` not calling `mayGrantTo` reds "the wrong vendor is refused at mint".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getUser } from '../src/features/users/usersService.js';
import {
  grantAccess, grantResourceKind, registerGrantResourceKind, type CollaboratorGrant, type GrantViewer,
} from '../src/host/externalCollaborators.js';

let BASE: string;
let server: http.Server;
const open = new Set<string>();
const KIND = 'p0c-po';
/** collaboratorId → the vendor it is (the adopter's own mapping). */
const vendorOf = new Map<string, string>();
/** The purchase orders: each line names its vendor. `po-shared` carries two vendors. */
const POS: Record<string, { owner: string; lines: Array<{ vendor: string; sku: string }> }> = {
  'po-a': { owner: 'A', lines: [{ vendor: 'A', sku: 'oak-panel' }] },
  'po-shared': { owner: 'A', lines: [{ vendor: 'A', sku: 'brass-pull' }, { vendor: 'B', sku: 'linen-shade' }] },
};
const projectSpy = vi.fn<(id: string, viewer?: GrantViewer) => void>();

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('users');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  registerGrantResourceKind(KIND, {
    featureId: null,
    actions: ['view', 'comment', 'mark-ready'],
    grantScope: 'workspace:write',
    requiresViewer: true,
    async exists(_t, _o, id) { return id in POS; },
    async project(_t, _o, id, viewer) {
      projectSpy(id, viewer);
      const vendor = viewer ? vendorOf.get(viewer.collaboratorId) : undefined;
      const po = POS[id];
      if (!po || !vendor) return null; // the kind's own fail-closed: an unattributed viewer sees nothing
      return { title: `PO ${id}`, body: { lines: po.lines.filter((l) => l.vendor === vendor).map((l) => l.sku) } };
    },
    async mayGrantTo(_t, _o, id, recipient) {
      const po = POS[id];
      const vendor = vendorOf.get(recipient.collaboratorId);
      return Boolean(po && vendor && po.lines.some((l) => l.vendor === vendor));
    },
    surface: {
      async enabledFor(tenantId) { return open.has(tenantId); },
      async orgOpen(tenantId, orgId) { return open.has(`${tenantId}:${orgId}`); },
    },
  });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T; raw: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1] ?? cookie; }
    const raw = res.status === 204 ? '' : await res.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T, raw };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
type Client = ReturnType<typeof client>;
const C = (orgId: string): string => `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/collaborators`;

let n = 0;
async function firm() {
  const tenantId = `ws:t-1099c-${n++}`;
  const admin = client();
  const a = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `owner-${n}@firm.test`, tenantId });
  expect(a.status).toBe(201);
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Hillside kitchen' });
  open.add(tenantId);
  open.add(`${tenantId}:${org.body.orgId}`);
  return { tenantId, orgId: org.body.orgId, admin, adminId: a.body.user.userId };
}
/** A vendor invited and accepted over the host routes, mapped to vendor `letter`. */
async function vendor(f: { orgId: string; admin: Client }, letter: string) {
  const http = client();
  const v = await http.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `vendor-${letter}-${n++}@mill.test` });
  const email = (await getUser(v.body.user.userId))?.email ?? '';
  const inv = await f.admin.post<{ collaborator: { collaboratorId: string }; invite: { token: string } }>(C(f.orgId), { kind: 'vendor', email, displayName: `Vendor ${letter}` });
  expect(inv.status, inv.raw).toBe(201);
  expect((await http.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token })).status).toBe(200);
  vendorOf.set(inv.body.collaborator.collaboratorId, letter);
  return { http, collaboratorId: inv.body.collaborator.collaboratorId };
}
const mint = (f: { tenantId: string; orgId: string; adminId: string }, collaboratorId: string, id: string): Promise<CollaboratorGrant> =>
  grantAccess({ tenantId: f.tenantId, orgId: f.orgId, collaboratorId, resource: { kind: KIND, id }, actions: ['view'], createdBy: f.adminId });

describe('ADR 1099 P0c — projections are per viewer', () => {
  it('a second vendor\'s grant never projects the first vendor\'s PO (one id per grant)', async () => {
    const f = await firm();
    const a = await vendor(f, 'A');
    const b = await vendor(f, 'B');
    const ga = await mint(f, a.collaboratorId, 'po-a');
    const gb = await mint(f, b.collaboratorId, 'po-shared');
    // B cannot read A's grant (it is bound to A), and its own grant is a different id.
    expect((await b.http.get(`/host/openwop-app/collab/grants/${ga.grantId}`)).status).toBe(404);
    const shared = await b.http.get<{ items: Array<{ grantId: string }> }>('/host/openwop-app/collab/shared');
    expect(shared.body.items.map((i) => i.grantId)).toEqual([gb.grantId]);
    const mine = await a.http.get<{ resource: { lines: string[] } }>(`/host/openwop-app/collab/grants/${ga.grantId}`);
    expect(mine.status, mine.raw).toBe(200);
    expect(mine.body.resource.lines).toEqual(['oak-panel']);
  });

  it('each vendor sees only its own lines of a PO they share', async () => {
    const f = await firm();
    const a = await vendor(f, 'A');
    const b = await vendor(f, 'B');
    const ga = await mint(f, a.collaboratorId, 'po-shared');
    const gb = await mint(f, b.collaboratorId, 'po-shared');
    const va = await a.http.get<{ resource: { lines: string[] } }>(`/host/openwop-app/collab/grants/${ga.grantId}`);
    const vb = await b.http.get<{ resource: { lines: string[] } }>(`/host/openwop-app/collab/grants/${gb.grantId}`);
    expect(va.status, va.raw).toBe(200);
    expect(vb.status, vb.raw).toBe(200);
    expect(va.body.resource.lines).toEqual(['brass-pull']);
    expect(vb.body.resource.lines).toEqual(['linen-shade']);
    // Non-vacuity: the host handed the kind the viewer it filtered by.
    expect(projectSpy).toHaveBeenCalledWith('po-shared', { collaboratorId: b.collaboratorId, grantId: gb.grantId });
  });

  it('no viewer, nothing: a host path that projects without a collaborator never reaches the kind', async () => {
    projectSpy.mockClear();
    const kind = grantResourceKind(KIND);
    expect(kind).toBeDefined();
    expect(await kind!.project('t', 'o', 'po-shared')).toBeNull();
    expect(await kind!.project('t', 'o', 'po-shared', { collaboratorId: '', grantId: '' })).toBeNull();
    expect(projectSpy).not.toHaveBeenCalled();
  });

  it('a kind that does not require a viewer projects as before', async () => {
    registerGrantResourceKind('p0c-plain', {
      featureId: null, actions: ['view'], async exists() { return true; },
      async project() { return { title: 'Plain', body: { ok: true } }; },
    });
    expect(await grantResourceKind('p0c-plain')!.project('t', 'o', 'x')).toEqual({ title: 'Plain', body: { ok: true } });
  });
});

describe('ADR 1099 P0c — the kind may refuse a recipient at mint', () => {
  it('the wrong vendor is refused at mint (400 grant_recipient_refused); the right one is granted', async () => {
    const f = await firm();
    const a = await vendor(f, 'A');
    const b = await vendor(f, 'B');
    const r = await f.admin.post<{ error: string; details?: { reason?: string } }>(`${C(f.orgId)}/${b.collaboratorId}/grants`, { resource: { kind: KIND, id: 'po-a' }, actions: ['view'] });
    expect(r.status, r.raw).toBe(400);
    expect(r.body.details?.reason).toBe('grant_recipient_refused');
    const ok = await f.admin.post(`${C(f.orgId)}/${a.collaboratorId}/grants`, { resource: { kind: KIND, id: 'po-a' }, actions: ['view'] });
    expect(ok.status, ok.raw).toBe(201);
  });

  it('a recipient the kind cannot attribute is refused (fail closed)', async () => {
    const f = await firm();
    const stranger = await vendor(f, 'Z'); // maps to a vendor with no lines anywhere
    await expect(mint(f, stranger.collaboratorId, 'po-shared')).rejects.toMatchObject({ httpStatus: 400 });
  });
});
