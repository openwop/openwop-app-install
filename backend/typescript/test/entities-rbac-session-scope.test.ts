/**
 * ENTC-1 (re-scoped) — the entities REST door's three-tier RBAC is DOCUMENTED but
 * not ENFORCED on the session path.
 *
 * `routes.ts:1-13` states the contract normatively:
 *     read = workspace:read · entity write = workspace:write
 *     type admin = host:members:manage · "missing scope → 403"
 * and names the shape it composes: `resolveEffectiveAccess(tenantId, { subject })`.
 *
 * The code at `routes.ts:151` passes `actingMember ? { memberId } : {}` instead.
 * With NEITHER `memberId` NOR `subject`, `resolveEffectiveAccess` skips the member
 * lookup entirely and returns `{ roles: ['owner'], scopes: OWNER_SCOPES,
 * basis: 'tenant-owner' }` — so for every ordinary session caller the scope check
 * `access.scopes.includes(scope)` passes unconditionally and the advertised 403
 * can never fire.
 *
 * MEASURED across the repo: ~100 `resolveEffectiveAccess` call sites, and all but
 * entities and environments pass `{ subject }`. This is an outlier, not a house
 * style. The filed row said the CHAT tool "under-enforces vs the REST read door";
 * the direction was wrong — the REST door's strictness is itself an illusion on
 * the session path, so the chat tool was being compared against a gate that does
 * not gate.
 *
 * These legs assert the DOCUMENTED contract, so they are born red.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember, resolveEffectiveAccess, resolveSubjectScopesUnion, resolveTenantLevelScopes } from '../src/host/accessControlService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const BASE = '/v1/host/openwop-app/entities';
let server: http.Server;
let ORIGIN = '';
let WS = '';
let n = 0;

interface Client { userId: string; post: (p: string, b?: unknown) => Promise<{ status: number; body: any }> }

async function loginTo(tenantId: string, who: string): Promise<Client> {
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
  return { userId: r.body.user.userId, post: (p, b) => call('POST', p, b) };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_DEMO_MODE; // the demo single-principal exception must not mask this
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const ws = await createWorkspace({ name: 'Entities RBAC', ownerSubject: 'oidc:ent-founder' });
  WS = ws.orgId ?? ws.tenantId;
  for (const id of ['entities', 'environments', 'users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ENTC-1 — a VIEWER must not pass the entities write/admin gates', () => {
  it('the premise: with neither memberId nor subject, resolveEffectiveAccess returns TENANT-OWNER', async () => {
    const anon = await resolveEffectiveAccess(WS, {});
    expect(anon.basis, 'this is why the route gate cannot refuse a session caller').toBe('tenant-owner');
    expect(anon.scopes).toContain('host:members:manage');
  });

  it('control: a viewer MEMBER genuinely lacks the write and admin scopes', async () => {
    const viewer = await loginTo(WS, 'viewer');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Viewer', subject: viewer.userId, roles: ['viewer'] });
    const access = await resolveEffectiveAccess(WS, { subject: viewer.userId, orgId: WS });
    expect(access.basis).toBe('member');
    expect(access.scopes).toContain('workspace:read');
    expect(access.scopes).not.toContain('workspace:write');
    expect(access.scopes).not.toContain('host:members:manage');
  });

  it('a viewer is REFUSED at the type-admin door (contract: host:members:manage → 403)', async () => {
    const viewer = await loginTo(WS, 'viewer-types');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'V2', subject: viewer.userId, roles: ['viewer'] });
    const r = await viewer.post(`${BASE}/types`, { name: `t_${n++}`, fields: [{ key: 'title', label: 'Title', type: 'string' }] });
    expect(r.status, `a viewer created an entity TYPE: ${JSON.stringify(r.body)}`).toBe(403);
  });

  it('a viewer is REFUSED at the entity-write door (contract: workspace:write → 403)', async () => {
    // The author needs a REAL admin member row. Before ADR 0731 any session caller
    // resolved to tenant-owner, so a memberless "owner" passed — and a control that
    // passes for the wrong reason cannot detect the fix OVER-blocking.
    const owner = await loginTo(WS, 'owner-w');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Owner', subject: owner.userId, roles: ['admin'] });
    const typeName = `w_${n++}`;
    const made = await owner.post(`${BASE}/types`, { name: typeName, fields: [{ key: 'title', label: 'Title', type: 'string' }] });
    expect([200, 201], `owner must be able to author the type: ${JSON.stringify(made.body)}`).toContain(made.status);
    const viewer = await loginTo(WS, 'viewer-rows');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'V3', subject: viewer.userId, roles: ['viewer'] });
    const r = await viewer.post(`${BASE}/types/${typeName}/entities`, { values: { title: 'x' } });
    expect(r.status, `a viewer wrote an entity row: ${JSON.stringify(r.body)}`).toBe(403);
  });
});

describe('ADR 0731 — the gate still has an EXIT, and resolves the TENANT-LEVEL union', () => {
  it('an admin member passes BOTH doors (a gate with no exit would be a worse defect)', async () => {
    const admin = await loginTo(WS, 'admin-exit');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'A', subject: admin.userId, roles: ['admin'] });
    const typeName = `e_${n++}`;
    const made = await admin.post(`${BASE}/types`, { name: typeName, fields: [{ key: 'title', label: 'Title', type: 'string' }] });
    expect([200, 201], `admin refused the type door: ${JSON.stringify(made.body)}`).toContain(made.status);
    const row = await admin.post(`${BASE}/types/${typeName}/entities`, { values: { title: 'ok' } });
    expect([200, 201], `admin refused the row door: ${JSON.stringify(row.body)}`).toContain(row.status);
  });

  it('a MULTI-ORG subject gets the UNION of their memberships, not a store-order first match', async () => {
    // This is the leg that distinguishes the two resolvers. `resolveEffectiveAccess
    // ({ subject })` is org-scoped FIRST-MATCH: viewer-in-A / admin-in-B resolves to
    // whichever row the store returns first, so this assertion would be a coin flip.
    // `resolveSubjectScopesUnion` unions across memberships and is deterministic.
    const user = await loginTo(WS, 'multi-org');
    const orgB = (await user.post('/v1/host/openwop-app/orgs', { name: `B_${n++}` })).body?.orgId;
    expect(typeof orgB, 'a second org must exist or this leg is vacuous').toBe('string');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'LowInA', subject: user.userId, roles: ['viewer'] });
    await createMember({ orgId: orgB, tenantId: WS, displayName: 'HighInB', subject: user.userId, roles: ['admin'] });
    const union = await resolveSubjectScopesUnion(WS, user.userId);
    expect(union.basis).toBe('member');
    expect(union.scopes, 'the admin membership must contribute').toContain('host:members:manage');
    // ...and the door agrees with the union, deterministically.
    const made = await user.post(`${BASE}/types`, { name: `m_${n++}`, fields: [{ key: 'title', label: 'Title', type: 'string' }] });
    expect([200, 201], `union-admin refused: ${JSON.stringify(made.body)}`).toContain(made.status);
  });
});

describe('ADR 0731 D4 — ENVIRONMENTS is the same defect in the same shape', () => {
  const ENV = '/v1/host/openwop-app/environments';

  it('a viewer is REFUSED at the environment-create door (contract: host:members:manage → 403)', async () => {
    const viewer = await loginTo(WS, 'viewer-env');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'VE', subject: viewer.userId, roles: ['viewer'] });
    const r = await viewer.post(ENV, { name: `env_${n++}` });
    expect(r.status, `a viewer created an environment: ${JSON.stringify(r.body)}`).toBe(403);
  });

  it('...and an admin member still passes it (the exit)', async () => {
    const admin = await loginTo(WS, 'admin-env');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'AE', subject: admin.userId, roles: ['admin'] });
    const r = await admin.post(ENV, { name: `env_${n++}` });
    expect([200, 201], `admin refused the environment door: ${JSON.stringify(r.body)}`).toContain(r.status);
  });
});

describe('ADR 0731 D5 — the CLASS ratchet: a route helper must not resolve authz without a caller', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const routeHelpers = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(full); }
        else if (e.name.endsWith('.ts')) out.push(full);
      }
    };
    walk(join(SRC, 'features'));
    walk(join(SRC, 'routes'));
    return out;
  };

  const offenders = (files: string[]): string[] => files.filter((f) => {
    const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    return /resolveEffectiveAccess\(\s*[A-Za-z_$][\w$.]*\s*,\s*\{\s*\}\s*\)/.test(code);
  }).map((f) => f.slice(SRC.length + 1));

  it('no feature/route file resolves authz with a literal empty options object', () => {
    const files = routeHelpers();
    expect(files.length, 'the walk must find files or this leg is vacuous').toBeGreaterThan(50);
    expect(offenders(files)).toEqual([]);
  });

  it('the ternary form that caused ADR 0731 is gone from BOTH instances', () => {
    for (const rel of ['features/entities/routes.ts', 'features/environments/routes.ts']) {
      const code = readFileSync(join(SRC, rel), 'utf8');
      expect(code, `${rel} must not resolve authz with {} again`).not.toMatch(/actingMember \? \{ memberId: actingMember\.trim\(\) \} : \{\}/);
      expect(code, `${rel} must resolve the session caller`).toMatch(/resolveTenantLevelScopes\(tenantId, subject\)/);
    }
  });

  it('control: the detector FIRES on a planted instance (so the empty list is a measurement)', () => {
    const planted = 'const a = await resolveEffectiveAccess(tenantId, {});';
    expect(/resolveEffectiveAccess\(\s*[A-Za-z_$][\w$.]*\s*,\s*\{\s*\}\s*\)/.test(planted)).toBe(true);
    // ...and the deliberate env-key site (no second argument at all) is NOT matched.
    expect(/resolveEffectiveAccess\(\s*[A-Za-z_$][\w$.]*\s*,\s*\{\s*\}\s*\)/.test('await resolveEffectiveAccess(tenantId)')).toBe(false);
  });
});

describe('ADR 0731 D6 — the single-principal sandbox keeps its exit (ADR 0372)', () => {
  it('an anon/personal tenant with NO member row is its OWN owner', async () => {
    for (const t of ['anon:sandbox-1', 'user:personal-1', 'default']) {
      const r = await resolveTenantLevelScopes(t, 'nobody-in-particular');
      expect(r.basis, `${t} must stay self-owned`).toBe('tenant-owner');
      expect(r.scopes, t).toContain('host:members:manage');
    }
  });

  it('a SHARED ws: workspace with no member row FAILS CLOSED (the escalation being fixed)', async () => {
    const r = await resolveTenantLevelScopes(WS, 'not-a-member-of-this-workspace');
    expect(r.basis).toBe('none');
    expect(r.scopes).toEqual([]);
  });

  it('...and a real member of that shared workspace still resolves their own scopes', async () => {
    const u = await loginTo(WS, 'member-exit');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'ME', subject: u.userId, roles: ['viewer'] });
    const r = await resolveTenantLevelScopes(WS, u.userId);
    expect(r.basis).toBe('member');
    expect(r.scopes).toContain('workspace:read');
    expect(r.scopes).not.toContain('host:members:manage');
  });
});
