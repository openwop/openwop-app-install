/**
 * ADR 1016 D1/D2/D6 — the model-router config is the WORKSPACE's, written by an
 * admin, and it is the config the chat reads. At the HTTP boundary, with the
 * ADR 0779 shared-workspace harness (log in with `sharedWorkspace: true`,
 * membership in the workspace-ROOT org, member rows created before login).
 *
 * Breaks if:
 *  - a config saved through the route is not the one the chat exchange reads
 *    (MR66WF-1: per-org writes were never read — leg 1 reads it back through
 *    `resolveTurnModelRoute`, the exchange's own reader);
 *  - an editor (`workspace:write`) can re-point the workspace's chats (MRC-1 —
 *    leg 2: writes need `host:byok:manage`), or `canManage` lies either way;
 *  - the legacy per-org alias accepts an org id other than the workspace's own
 *    (a silent write nobody reads — leg 3), or refuses the workspace id the CLI
 *    passes;
 *  - the preview disagrees with the exchange's decision, ignores the provider
 *    constraint, or accepts a provider that is not routable (leg 4);
 *  - a model the catalog does not list is accepted (leg 5).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { resolveTurnModelRoute } from '../src/features/model-router/resolveRoute.js';

const CFG = '/host/openwop-app/model-router/config';
let server: Server;
let BASE = '';
let WS = '';
const ADMIN = 'oidc:r1016-admin';
const EDITOR = 'oidc:r1016-editor';
const BIG = 'claude-opus-5-5';
const config = {
  rules: [{ when: { kind: 'tokensOver', threshold: 1000 }, target: { provider: 'anthropic', model: BIG } }],
};

async function login(subject: string, tenantId: string): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace: true }),
  });
  expect(res.status, 'test seam must mint a session').toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function call(path: string, cookie: string, method = 'GET', body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

function field(value: unknown, ...path: string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = Reflect.get(cur, key);
  }
  return cur;
}

let admin = '';
let editor = '';
beforeAll(async () => {
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const ws = await createWorkspace({ name: 'ADR 1016 workspace', ownerSubject: 'oidc:r1016-owner' });
  WS = ws.orgId ?? ws.tenantId;
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: userIdFor(WS, ADMIN), roles: ['admin'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, EDITOR), roles: ['editor'] });
  admin = await login(ADMIN, WS);
  editor = await login(EDITOR, WS);
});

afterAll(async () => {
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('ADR 1016 — the workspace router config', () => {
  it('leg 1: what an admin saves through the route is what the chat exchange reads', async () => {
    const put = await call(CFG, admin, 'PUT', config);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(field(put.body, 'config', 'orgId')).toBe(WS);
    expect((await call(`${CFG}/enable`, admin, 'POST', { enabled: true })).status).toBe(200);
    // The exchange's own reader, for an anthropic-keyed conversation in this workspace.
    const route = await resolveTurnModelRoute({
      tenantId: WS, runInputs: { provider: 'anthropic', credentialRef: 'anthropic' },
      credentialProviders: ['anthropic', 'openai', 'google'], userText: 'x'.repeat(8000),
    });
    expect(route).toEqual({ provider: 'anthropic', model: BIG });
  });

  it('leg 2: an editor reads (canManage:false) but cannot write; an admin has canManage:true', async () => {
    const read = await call(CFG, editor);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(field(read.body, 'canManage')).toBe(false);
    expect(field(read.body, 'config', 'config', 'rules')).toEqual(config.rules);
    for (const [path, method, body] of [[CFG, 'PUT', config], [`${CFG}/enable`, 'POST', { enabled: false }]] as const) {
      const refused = await call(path, editor, method, body);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(field(refused.body, 'details', 'requiredScope')).toBe('host:byok:manage');
    }
    expect(field((await call(CFG, admin)).body, 'canManage')).toBe(true);
  });

  it('leg 3: the legacy per-org alias accepts only the workspace\'s own id', async () => {
    const ok = await call(`/host/openwop-app/model-router/orgs/${encodeURIComponent(WS)}/config/enable`, admin, 'POST', { enabled: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const other = await call('/host/openwop-app/model-router/orgs/org-deadbeef/config', admin, 'PUT', config);
    expect(other.status, JSON.stringify(other.body)).toBe(409);
    expect(field(other.body, 'details', 'reason')).toBe('model_router_workspace_scoped');
    // The authority gate runs FIRST: an editor learns nothing from the alias.
    expect((await call('/host/openwop-app/model-router/orgs/org-deadbeef/config', editor, 'PUT', config)).status).toBe(403);
  });

  it('leg 4: preview runs the same decision, per provider, without writing', async () => {
    const long = await call(`${CFG}/preview`, editor, 'POST', { text: 'x'.repeat(8000), provider: 'anthropic' });
    expect(long.status, JSON.stringify(long.body)).toBe(200);
    expect(long.body).toMatchObject({ enabled: true, why: 'routed', decision: { reason: 'rule', ruleIndex: 0, target: { provider: 'anthropic', model: BIG } } });
    // An openai conversation cannot call the anthropic rule: it keeps its own model.
    expect((await call(`${CFG}/preview`, editor, 'POST', { text: 'x'.repeat(8000), provider: 'openai' })).body)
      .toMatchObject({ decision: null, why: 'no_match' });
    expect((await call(`${CFG}/preview`, editor, 'POST', { text: 'short', provider: 'anthropic' })).body)
      .toMatchObject({ decision: null, why: 'no_match' });
    const bad = await call(`${CFG}/preview`, editor, 'POST', { text: 'x', provider: 'compat' });
    expect(bad.status).toBe(400);
    expect(field(bad.body, 'details', 'field')).toBe('provider');
  });

  it('leg 5: a model the catalog does not list is refused at write', async () => {
    const res = await call(CFG, admin, 'PUT', { rules: [{ when: { kind: 'always' }, target: { provider: 'anthropic', model: 'claude-typo' } }] });
    expect(res.status).toBe(400);
    expect(field(res.body, 'details', 'field')).toBe('rules[0].target.model');
  });
});
