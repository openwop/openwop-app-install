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
import { createWorkspace, createMember, createOrg } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';

let BASE: string;
let server: http.Server;
let wsTenant: string;
let editorCookie: string;
let adminCookie: string;
let editorUserId: string;
let adminUserId: string;

const PEOPLE = '/host/openwop-app/kicktodo/org-programs/admin/people';

const craftCookie = (userId: string, activeTenant: string, personalTenant: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: activeTenant, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const seatMember = async (principalId: string, roles: string[], personalTenant: string): Promise<{ cookie: string; userId: string }> => {
  const user = await upsertFromPrincipal({ tenantId: wsTenant, principalId, source: 'oidc' });
  await createMember({ tenantId: wsTenant, orgId: wsTenant, subject: user.userId, displayName: `Person ${principalId}`, roles });
  return { cookie: craftCookie(user.userId, wsTenant, personalTenant), userId: user.userId };
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
  ({ cookie: editorCookie, userId: editorUserId } = await seatMember('oidc:people-editor', ['editor'], 'ws:home-people-editor'));
  ({ cookie: adminCookie, userId: adminUserId } = await seatMember('oidc:people-admin', ['admin'], 'ws:home-people-admin'));
  // The DEDUPE fixture: the editor is ALSO seated in a sub-org — two membership
  // rows, ONE person. Without subject-dedupe the editor would count twice.
  const sub = await createOrg({ tenantId: wsTenant, name: 'People sub-org', createdBy: 'user:setup' });
  await createMember({ tenantId: wsTenant, orgId: sub.orgId, subject: editorUserId, displayName: 'Person oidc:people-editor (sub)', roles: ['editor'] });
  // The ROLELESS fixture: a person whose only seat carries no role at all.
  await createMember({ tenantId: wsTenant, orgId: wsTenant, subject: 'user:people-roleless', displayName: 'Person oidc:people-roleless', roles: [] });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0438 A4 — People & access aggregate lens', () => {
  // TWIN: `kicktodo-authz-http.test.ts` › "GET …/org-programs/admin/people" ›
  // "EDITOR member is REFUSED 403" (both red on w40g1-ppl-gate-gone /
  // http-ppl-gate-gone). Kept as this file's own refusal control (protected).
  it('an editor (no manage) gets 403 forbidden_scope — not a leaky 404', async () => {
    const r = await call(editorCookie);
    expect(r.status).toBe(403);
    expect(String(r.body?.error ?? r.body?.code ?? '')).toContain('forbidden_scope');
    expect(r.raw).toContain('Missing required scope: host:kicktodo:manage');
  });

  it('an admin gets the aggregate shape: role counts + per-org counts, honest consent posture', async () => {
    const r = await call(adminCookie);
    expect(r.status).toBe(200);
    // Members: counts only — PEOPLE, not rows. owner + editor (two seats, one
    // person) + admin + roleless = 4 people.
    expect(r.body.members!.total).toBe(4);
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
    expect(r.body.members!.rolelessCount).toBe(1);
    expect(JSON.stringify(r.body.members!.byRole)).not.toContain('(none)');
    // Equal counts (1 each — the editor's two seats count once) tie-break by role name.
    expect(r.body.members!.byRole).toEqual([
      { role: 'admin', count: 1 },
      { role: 'editor', count: 1 },
      { role: 'owner', count: 1 },
    ]);
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
    // VALUES, not just key names: no member's subject id serializes under ANY key.
    expect(r.raw).not.toContain(editorUserId);
    expect(r.raw).not.toContain(adminUserId);
    expect(r.raw).not.toContain('user:people-roleless');
  });
});
