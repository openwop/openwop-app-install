/**
 * UAC-1 / EVC-1 — the admin-tier read routes must gate on an ADMIN scope, not the
 * `workspace:read` VIEWER scope. Before this fix both the Usage-analytics rollup and
 * the Evals leaderboard + arena/rating gated on `workspace:read`, so a read-only
 * VIEWER (and an editor) could read tenant-wide AI spend / model rankings — data the
 * FE only ever exposes under `<AdminLayout>`. The fix gates them on
 * `host:members:manage` (the admin/owner-only management scope the FE's `isAdminCaller`
 * keys on; the same one `docs/routes.ts` reuses as a generic workspace-admin gate).
 *
 * Both directions are witnessed per route: a viewer/editor is REFUSED (403
 * forbidden_scope), an admin PASSES (200). The `arena/match` WRITE stays
 * `workspace:write` and is not part of this class.
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
let viewerCookie: string;
let editorCookie: string;
let adminCookie: string;

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
  for (const id of ['users', 'usage-analytics', 'evals']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const ws = await createWorkspace({ name: 'Admin Scope', ownerSubject: 'oidc:as-owner' });
  wsTenant = ws.tenantId;
  viewerCookie = await seat('oidc:as-viewer', ['viewer']);
  editorCookie = await seat('oidc:as-editor', ['editor']);
  adminCookie = await seat('oidc:as-admin', ['admin']);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const usage = () => `/v1/host/openwop-app/usage/orgs/${wsTenant}/rollup`;
const leaderboard = () => `/v1/host/openwop-app/evals/orgs/${wsTenant}/leaderboard`;
const rating = () => `/v1/host/openwop-app/evals/orgs/${wsTenant}/arena/rating?model=gpt-x`;

describe('UAC-1/EVC-1 — admin-tier reads gate on host:members:manage, not workspace:read', () => {
  it('Usage rollup: viewer + editor REFUSED (403 forbidden_scope), admin passes (200)', async () => {
    const v = await get(usage(), viewerCookie);
    expect(v.status).toBe(403);
    expect(v.text).toContain('forbidden_scope');
    expect((await get(usage(), editorCookie)).status).toBe(403); // editor has workspace:read+write, not manage
    const a = await get(usage(), adminCookie);
    expect(a.status).toBe(200);
    expect(a.text).toContain('rollup');
  });

  it('Evals leaderboard: viewer REFUSED (403), admin passes (200)', async () => {
    const v = await get(leaderboard(), viewerCookie);
    expect(v.status).toBe(403);
    expect(v.text).toContain('forbidden_scope');
    const a = await get(leaderboard(), adminCookie);
    expect(a.status).toBe(200);
    expect(a.text).toContain('leaderboard');
  });

  it('Evals arena/rating: viewer REFUSED (403), admin passes (200)', async () => {
    const v = await get(rating(), viewerCookie);
    expect(v.status).toBe(403);
    expect(v.text).toContain('forbidden_scope');
    const a = await get(rating(), adminCookie);
    expect(a.status).toBe(200);
    expect(a.text).toContain('elo');
  });
});
