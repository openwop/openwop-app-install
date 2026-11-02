/**
 * ADR 0975 D12 — `/me/workspaces` names KickTodo's chat agent on its participant
 * workspace, and on no other row.
 *
 * The SPA opens a new plain chat in the active workspace scoped to this agent, so
 * a participant who types straight into the composer reaches KickBot, the one
 * agent D11 admits them to, instead of the generic assistant (refused
 * `runs:create` on kicktodo.com, 2026-10-31 13:25:23Z). The value is the feature's
 * DECLARATION (`defaultOrg.chatAgent`), read through the boot-recorded default
 * workspace targets, so this runs the real app: createApp provisions
 * `host-kicktodo` and records the targets from the real feature registry.
 *
 * Red when (sabotage-witnessed in the PR): `chatAgent` is dropped from
 * `featureDefaultOrgs`, from the route's row, or from KickTodo's declaration; the
 * route attaches it to every shared row instead of the declared one.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createWorkspace, listMembers } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { KICKBOT_AGENT_ID } from '../src/features/kicktodo-core/kickbotService.js';

const WS = 'host-kicktodo';
const TOGGLES = ['users', 'kicktodo-core'];

interface WorkspaceRow { workspaceId: string; kind: string; roles: string[]; chatAgent?: string }
let BASE = '';
let server: http.Server;
let cookie = '';
let OTHER = '';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_SESSION_SECRET', 'OPENWOP_AUTH_DISABLE_COOKIES']) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0975-d12', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of TOGGLES) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  // A participant: a viewer in the declared workspace, and also a member of an
  // ordinary shared workspace (which must carry no chat agent).
  const user = await upsertFromPrincipal({ tenantId: WS, principalId: 'oidc:d12-participant', source: 'oidc' });
  if (!(await listMembers(WS, WS)).some((m) => m.subject === user.userId)) {
    await createMember({ tenantId: WS, orgId: WS, subject: user.userId, displayName: 'Participant', roles: ['viewer'] });
  }
  OTHER = (await createWorkspace({ name: 'Other team', ownerSubject: user.userId })).orgId;
  const now = Math.floor(Date.now() / 1000);
  cookie = `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: WS, tier: 'user', userId: user.userId, personalTenant: `user:${randomBytes(16).toString('hex')}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const id of TOGGLES) {
    const d = getToggleDefault(id);
    if (d) await saveConfig(d, 'test');
  }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('ADR 0975 D12 — the participant workspace names its chat agent', () => {
  it('HEADLINE: the participant\'s active KickTodo row carries chatAgent = KickBot', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/me/workspaces`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: WorkspaceRow[]; active: string };
    expect(body.active).toBe(WS);
    const row = body.workspaces.find((w) => w.workspaceId === WS);
    expect(row, 'the participant lists the KickTodo workspace').toBeDefined();
    expect(row!.roles).toEqual(['viewer']);
    expect(row!.chatAgent).toBe(KICKBOT_AGENT_ID);
  });

  it('no other row names a chat agent: the personal workspace and an ordinary shared one are unchanged', async () => {
    const body = (await (await fetch(`${BASE}/host/openwop-app/me/workspaces`, { headers: { cookie } })).json()) as { workspaces: WorkspaceRow[] };
    const others = body.workspaces.filter((w) => w.workspaceId !== WS);
    expect(others.map((w) => w.workspaceId)).toContain(OTHER); // not vacuous: the other row is there
    expect(others.some((w) => w.kind === 'personal')).toBe(true);
    for (const w of others) expect(w, w.workspaceId).not.toHaveProperty('chatAgent');
  });
});
