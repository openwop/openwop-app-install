/**
 * COS-11 (docs/steward/CODEBASE-ASSESSMENT.md, the SECURITY item) — the assistant
 * READ routes were unscoped (`wrap`), so a non-member could read the tenant
 * work-graph and a read-only VIEWER could read every drafted outbound BODY +
 * recipient address on `/pending-actions` — on the same surface whose WRITES were
 * hardened on `workspace:write` for exactly that reason (routes.ts:74-78).
 *
 * The fix uses the ONE shared predicate (`requireTenantScope`):
 *   - the shared work-graph (commitments/decisions/meetings/stakeholders/projects)
 *     gates on `workspace:read` — any member reads it, a NON-MEMBER is denied;
 *   - `/pending-actions` gates on `workspace:write` — the drafted outbound bodies
 *     are readable only by someone who could send them (a VIEWER is denied).
 *
 * Both directions are witnessed per class (viewer vs editor vs non-member),
 * driving the real HTTP boundary + cookie session (the wiring, not a helper).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember, createCustomRole } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';

let BASE: string;
let server: http.Server;
let wsTenant: string;
let viewerCookie: string;
let editorCookie: string;
let noReadCookie: string;

const craftCookie = (userId: string, activeTenant: string, personalTenant: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: activeTenant, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const seat = async (principalId: string, roles: string[]): Promise<string> => {
  const user = await upsertFromPrincipal({ tenantId: wsTenant, principalId, source: 'oidc' });
  await createMember({ tenantId: wsTenant, orgId: wsTenant, subject: user.userId, displayName: principalId, roles });
  return craftCookie(user.userId, wsTenant, `ws:home-${principalId}`);
};
const get = async (path: string, cookie: string): Promise<{ status: number; text: string }> => {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
  return { status: res.status, text: await res.text() };
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const ws = await createWorkspace({ name: 'Assistant COS-11', ownerSubject: 'oidc:cos11-owner' });
  wsTenant = ws.tenantId;
  viewerCookie = await seat('oidc:cos11-viewer', ['viewer']);
  editorCookie = await seat('oidc:cos11-editor', ['editor']);
  // A real MEMBER of the workspace (so the active-tenant switch is honoured) whose
  // custom role grants NO `workspace:read` — the caller a `workspace:read` gate
  // actually excludes. (A non-member can't switch into the workspace at all: the
  // auth middleware falls them back to their own personal tenant, so they only
  // ever read their own empty graph — which is why the DENIAL witness has to be a
  // scoped-down member, not a stranger.)
  const noReadRole = await createCustomRole({ tenantId: wsTenant, orgId: wsTenant, name: 'Runs-only', scopes: ['runs:read'] });
  noReadCookie = await seat('oidc:cos11-noread', [noReadRole.roleId]);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const A = '/v1/host/openwop-app/assistant';

describe('COS-11 — the work-graph reads gate on workspace:read', () => {
  for (const [name, path] of [
    ['commitments', `${A}/commitments`],
    ['decisions', `${A}/decisions`],
    ['meetings', `${A}/meetings`],
    ['stakeholders', `${A}/stakeholders`],
    ['projects', `${A}/projects`],
  ] as const) {
    it(`${name}: a member WITHOUT workspace:read is REFUSED (403); a viewer + editor read`, async () => {
      const denied = await get(path, noReadCookie);
      expect(denied.status).toBe(403); // before the fix these reads were unscoped (200)
      expect(denied.text).toContain('forbidden_scope');
      expect((await get(path, viewerCookie)).status).toBe(200); // a member reads normally
      expect((await get(path, editorCookie)).status).toBe(200);
    });
  }
});

describe('COS-11 — /pending-actions gates on workspace:write (a viewer cannot read drafts)', () => {
  it('a VIEWER is REFUSED (403); an editor (write authority) reads', async () => {
    // The priority: a read-only viewer must not read drafted outbound bodies +
    // recipient addresses. Before the fix this was an unscoped 200.
    const viewer = await get(`${A}/pending-actions`, viewerCookie);
    expect(viewer.status).toBe(403);
    expect(viewer.text).toContain('forbidden_scope');
    // The negative control: someone WITH write authority still reads normally, so
    // the gate is not refusing everyone.
    expect((await get(`${A}/pending-actions`, editorCookie)).status).toBe(200);
  });
});
