/**
 * ADR 0438 A4 — the admin "People & access" aggregate lens.
 *
 *  - manage-gated: an editor (workspace:write, NO manage) gets 403 forbidden_scope;
 *    an admin (host:kicktodo:manage) gets 200;
 *  - AGGREGATES ONLY: the payload carries member COUNTS by role and per-org
 *    link/library counts — never a per-person row (no names, emails, subjects),
 *    and no cohort OUTCOME aggregate (the B16 law: those stay behind the per-org
 *    report at org-manager authority);
 *  - the consent posture is declared honestly (`cohortAggregatesGated: true`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';

let BASE: string;
let server: http.Server;
let wsTenant: string;
let editorCookie: string;
let adminCookie: string;

const PEOPLE = '/v1/host/openwop-app/kicktodo/org-programs/admin/people';

const craftCookie = (userId: string, activeTenant: string, personalTenant: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: activeTenant, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const seatMember = async (principalId: string, roles: string[], personalTenant: string): Promise<string> => {
  const user = await upsertFromPrincipal({ tenantId: wsTenant, principalId, source: 'oidc' });
  await createMember({ tenantId: wsTenant, orgId: wsTenant, subject: user.userId, displayName: `Person ${principalId}`, roles });
  return craftCookie(user.userId, wsTenant, personalTenant);
};

interface PeopleBody {
  error?: string;
  code?: string;
  members?: { total: number; byRole: Array<{ role: string; count: number }>; rolelessCount: number };
  orgs?: Array<Record<string, unknown>>;
  consent?: { cohortAggregatesGated: boolean };
}
const call = async (cookie: string): Promise<{ status: number; body: PeopleBody; raw: string }> => {
  const res = await fetch(`${BASE}${PEOPLE}`, { headers: { cookie } });
  const raw = await res.text();
  let body: PeopleBody = {};
  try { body = JSON.parse(raw) as PeopleBody; } catch { /* non-JSON error body */ }
  return { status: res.status, body, raw };
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'kicktodo-core', 'kicktodo-organizations']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const ws = await createWorkspace({ name: 'KT People', ownerSubject: 'oidc:people-owner' });
  wsTenant = ws.tenantId;
  editorCookie = await seatMember('oidc:people-editor', ['editor'], 'ws:home-people-editor');
  adminCookie = await seatMember('oidc:people-admin', ['admin'], 'ws:home-people-admin');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0438 A4 — People & access aggregate lens', () => {
  it('an editor (no manage) gets 403 forbidden_scope — not a leaky 404', async () => {
    const r = await call(editorCookie);
    expect(r.status).toBe(403);
    expect(String(r.body?.error ?? r.body?.code ?? '')).toContain('forbidden_scope');
  });

  it('an admin gets the aggregate shape: role counts + per-org counts, honest consent posture', async () => {
    const r = await call(adminCookie);
    expect(r.status).toBe(200);
    // Members: counts only. The two seated members (+ any workspace owner seat).
    expect(r.body.members!.total).toBeGreaterThanOrEqual(2);
    const roles = new Map(r.body.members!.byRole.map((x) => [x.role, x.count]));
    expect(roles.get('editor')).toBeGreaterThanOrEqual(1);
    expect(roles.get('admin')).toBeGreaterThanOrEqual(1);
    // Orgs: aggregate row per org, with the lens fields and nothing person-shaped.
    expect(Array.isArray(r.body.orgs)).toBe(true);
    for (const org of r.body.orgs!) {
      expect(typeof org.name).toBe('string');
      expect(typeof org.memberCount).toBe('number');
      expect(typeof org.cohortLinkCount).toBe('number');
      expect(typeof org.libraryCurated).toBe('boolean');
    }
    // Grade-trio fix pins: counts are PEOPLE (subject-deduped), roleless people
    // ride a STRUCTURAL field (never an in-band '(none)' sentinel), and equal
    // counts tie-break deterministically by role name.
    expect(typeof r.body.members!.rolelessCount).toBe('number');
    expect(JSON.stringify(r.body.members!.byRole)).not.toContain('(none)');
    const sorted = [...r.body.members!.byRole].sort((a, b) => b.count - a.count || a.role.localeCompare(b.role));
    expect(r.body.members!.byRole).toEqual(sorted);
    // The B16 posture is declared, not silently omitted.
    expect(r.body.consent).toEqual({ cohortAggregatesGated: true });
  });

  it('the payload carries NO per-person data — no names, emails, subjects, or outcome cells', async () => {
    const r = await call(adminCookie);
    expect(r.status).toBe(200);
    expect(r.raw).not.toContain('Person oidc:');   // seeded displayNames never serialize
    expect(r.raw).not.toContain('email');
    expect(r.raw).not.toContain('subject');
    expect(r.raw).not.toContain('displayName');
    expect(r.raw).not.toContain('completionRate'); // no cohort OUTCOME aggregate here
  });
});
