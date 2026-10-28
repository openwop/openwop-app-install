/**
 * ADR 0826 D1 / D5 / D8 — the marketplace's authority edges, through real HTTP.
 *
 * D1 born RED on `f4b07997f`: a VIEWER in a shared `ws:` workspace got 200 from
 * `PUT /marketplace/pack-enablement/:pack {enabled:false}`, and the owner then saw
 * the pack disabled — a read-only member curated authoring availability for the
 * whole workspace (the route checked only that SOMEONE was signed in).
 * D8 born RED: `GET /registry/agent-packs` answered an anonymous caller 200.
 *
 * Built through the production path (sign in, create workspace, switch, invite,
 * accept), so the personal tenant is genuinely distinct from the active one and
 * the implicit-owner short-circuit cannot make a refusal vacuous. Every refusal
 * row has a success CONTROL beside it.
 *
 * Tracker TST-BMK-2. Sabotage-witnessed (w62): red when curation drops the
 * workspace-write check, `canCurate` stops reading the caller's scope, the
 * agent-pack list admits an anonymous caller, revocation drops the superadmin
 * check or the SemVer check or the audit row, or revocation is put behind the
 * marketplace toggle.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { isPackRevoked, __clearPackRevocations } from '../src/host/packRevocations.js';

let BASE = '';
let server: http.Server;
let n = 0;
let storage: Storage;

/** The response fields this file reads, across the routes it calls. */
interface Body {
  error?: string;
  message?: string;
  workspaceId?: string;
  token?: string;
  listings?: Array<{ packName: string; trust?: { tier?: string }; integrity?: string }>;
  disabled?: string[];
  viewer?: { canCurate: boolean; canAdminister: boolean };
  canInstall?: boolean;
  requiredBy?: string[];
  revocations?: Array<{ key: string }>;
}
interface Res { status: number; body: Body }
function client(bearer?: string) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    for (const sc of h.getSetCookie?.() ?? []) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]!; }
    // Narrowed to the fields this file reads (a non-JSON or 204 body reads as `{}`).
    const parsed = (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Body;
    return { status: res.status, body: parsed };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    put: (p: string, b?: unknown) => call('PUT', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;

const MKT = '/host/openwop-app/marketplace';

async function signIn(c: Client, email: string): Promise<void> {
  const r = await c.post('/host/openwop-app/test/login', { email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

/** owner + a viewer + an editor in ONE real `ws:` workspace, all switched into it. */
async function sharedWorkspace(): Promise<{ owner: Client; viewer: Client; editor: Client; ws: string }> {
  const owner = client(); const viewer = client(); const editor = client();
  const id = n++;
  await signIn(owner, `own-0826-${id}@x.test`);
  const ws = await owner.post('/host/openwop-app/workspaces', { name: `ADR 0826 ${id}` });
  expect(ws.status, JSON.stringify(ws.body)).toBe(201);
  const wsId = ws.body.workspaceId ?? '';
  expect(wsId).toMatch(/^ws:/);
  expect((await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(wsId)}/switch`)).status).toBe(200);
  for (const [c, role, email] of [[viewer, 'viewer', `view-0826-${id}@x.test`], [editor, 'editor', `edit-0826-${id}@x.test`]] as const) {
    const inv = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(wsId)}/invites`, { email, role });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    await signIn(c, email);
    expect((await c.post('/host/openwop-app/orgs/invitations/accept', { token: inv.body.token })).status).toBe(201);
    expect((await c.post(`/host/openwop-app/workspaces/${encodeURIComponent(wsId)}/switch`)).status).toBe(200);
  }
  return { owner, viewer, editor, ws: wsId };
}

async function somePack(c: Client): Promise<string> {
  const r = await c.get(`${MKT}/listings`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const name = (r.body.listings ?? []).find((l) => l.packName.startsWith('feature.'))?.packName;
  expect(name, 'the fixture needs at least one listed pack').toBeTruthy();
  return name!;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // The de-facto-owner bypass would hand every viewer OWNER scopes — a vacuous refusal.
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN; // keep the superadmin gate honest
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs', 'marketplace']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  await __clearPackRevocations();
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

describe('ADR 0826 D1 — pack curation is a workspace WRITE', () => {
  it('a VIEWER is refused 403 and the workspace is unchanged (born RED: 200 + disabled for everyone)', async () => {
    const { owner, viewer } = await sharedWorkspace();
    const pack = await somePack(owner);
    const r = await viewer.put(`${MKT}/pack-enablement/${encodeURIComponent(pack)}`, { enabled: false });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    // The workspace-write refusal itself (features/featureRoute.ts requireTenantWrite).
    expect(r.body.error).toBe('forbidden_scope');
    expect(r.body.message).toBe('Missing required scope: workspace:write');
    const seen = await owner.get(`${MKT}/pack-enablement`);
    expect(seen.body.disabled, 'positive read: the owner sees the list').toBeDefined();
    expect(seen.body.disabled).not.toContain(pack);
  });

  it('CONTROL: an EDITOR curates (200) and the owner sees it; the owner re-enables', async () => {
    const { owner, editor } = await sharedWorkspace();
    const pack = await somePack(owner);
    const r = await editor.put(`${MKT}/pack-enablement/${encodeURIComponent(pack)}`, { enabled: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await owner.get(`${MKT}/pack-enablement`)).body.disabled).toContain(pack);
    expect((await owner.put(`${MKT}/pack-enablement/${encodeURIComponent(pack)}`, { enabled: true })).status).toBe(200);
  });

  it('the read surfaces tell each caller what THEY may do — from the same predicates', async () => {
    const { owner, viewer, editor } = await sharedWorkspace();
    for (const [c, canCurate] of [[viewer, false], [editor, true], [owner, true]] as const) {
      const l = await c.get(`${MKT}/listings`);
      expect(l.body.viewer, JSON.stringify(l.body.viewer)).toEqual({ canCurate, canAdminister: false });
      expect((await c.get(`${MKT}/pack-enablement`)).body.viewer?.canCurate).toBe(canCurate);
    }
  });

  it('every listing carries its trust tier from the ONE trust authority (D6)', async () => {
    const { owner } = await sharedWorkspace();
    const l = await owner.get(`${MKT}/listings`);
    const listings = l.body.listings ?? [];
    expect(listings.length).toBeGreaterThan(0);
    for (const x of listings) expect(['steward', 'operator-trusted', 'untrusted', 'revoked']).toContain(x.trust?.tier);
    // integrity is shown ONLY for a verified registry install.
    for (const x of listings) if (x.integrity) expect(x.trust?.tier).toBe('operator-trusted');
  });
});

describe('ADR 0826 D8 — the agent-pack list needs a caller', () => {
  it('anonymous is refused (born RED: 200)', async () => {
    const r = await fetch(`${BASE}/host/openwop-app/registry/agent-packs`);
    expect(r.status).toBe(401);
    expect(((await r.json()) as Body).error).toBe('sign_in_required');
  });

  it('CONTROL: a signed-in member reads it', async () => {
    const { viewer } = await sharedWorkspace();
    const r = await viewer.get('/host/openwop-app/registry/agent-packs');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.canInstall).toBe(false);
  });
});

describe('ADR 0826 D5 — revocation routes are superadmin, validated, and take effect', () => {
  it('a workspace OWNER (not superadmin) is 403 on every revocation route', async () => {
    const { owner } = await sharedWorkspace();
    // Each refusal is the superadmin one (host/superadmin.ts), not another 403.
    for (const r of [
      await owner.get(`${MKT}/revocations`),
      await owner.post(`${MKT}/packs/acme.x/revocations`, { version: '1.0.0', reason: 'r' }),
      await owner.del(`${MKT}/packs/acme.x/revocations/1.0.0`),
    ]) {
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.message).toContain('requires a superadmin principal');
    }
    expect(isPackRevoked('acme.x', '1.0.0')).toBe(false);
  });

  it('a superadmin revokes (201, blast radius named), lists, and un-revokes; bad input is a 400', async () => {
    const su = client('dev-token');
    expect((await su.post(`${MKT}/packs/feature.marketplace.nodes/revocations`, { version: '1.0', reason: 'x' })).status).toBe(400);
    expect((await su.post(`${MKT}/packs/feature.marketplace.nodes/revocations`, { version: '1.1.1', reason: '   ' })).status).toBe(400);
    const r = await su.post(`${MKT}/packs/feature.marketplace.nodes/revocations`, { version: '1.1.1', reason: 'fixture: compromised' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.requiredBy, '/architect A6 — the features this takes down are named').toContain('marketplace');
    expect(isPackRevoked('feature.marketplace.nodes', '1.1.1')).toBe(true);
    const list = await su.get(`${MKT}/revocations`);
    expect((list.body.revocations ?? []).map((x) => x.key)).toContain('feature.marketplace.nodes@1.1.1');
    // The listing reflects it as `revoked` — the trust tier, not a marker read.
    const { owner } = await sharedWorkspace();
    const l = await owner.get(`${MKT}/listings`);
    expect((l.body.listings ?? []).find((x) => x.packName === 'feature.marketplace.nodes')?.trust?.tier).toBe('revoked');
    expect((await su.del(`${MKT}/packs/feature.marketplace.nodes/revocations/1.1.1`)).status).toBe(204);
    expect(isPackRevoked('feature.marketplace.nodes', '1.1.1')).toBe(false);
    // Both decisions are in the durable audit log, with the operator's reason.
    const audit = await storage.listAudit({ resource: 'pack:feature.marketplace.nodes@1.1.1' });
    expect(audit.map((a) => a.action).sort()).toEqual(['marketplace.pack.revoked', 'marketplace.pack.unrevoked']);
    expect(JSON.stringify(audit)).toContain('fixture: compromised');
    expect((await su.del(`${MKT}/packs/feature.marketplace.nodes/revocations/1.1.1`)).status).toBe(404);
  });

  it('revocation is NOT behind the marketplace toggle (a kill switch must not vanish with the feature)', async () => {
    const d = getToggleDefault('marketplace')!;
    await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      const su = client('dev-token');
      const r = await su.post(`${MKT}/packs/acme.toggle-off/revocations`, { version: '*', reason: 'incident' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(isPackRevoked('acme.toggle-off', '3.2.1')).toBe(true);
      expect((await su.del(`${MKT}/packs/acme.toggle-off/revocations/*`)).status).toBe(204);
    } finally {
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
});
