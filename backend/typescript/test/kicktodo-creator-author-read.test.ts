/**
 * ADR 0461 P1 — the Challenge Author profile read (`GET …/creator/author`)
 * backing the Studio's embedded-chat welcome screen.
 *
 * What matters here:
 *  - EAGER PROVISIONING: this GET is the tenant's FIRST creator touch, and it
 *    must return the roster truth (deterministic `host:challenge-author` id +
 *    the assigned factory workflow) — i.e. it AWAITS the provisioning saga
 *    rather than relying on gate()'s best-effort fire-and-forget.
 *  - HONEST PORTFOLIO: each portfolio row is verified against the live
 *    workflow catalog — the challenge-factory builtin resolves (`available:
 *    true`, real node count), so the welcome can never paint a workflow the
 *    host can't run.
 *  - AUTHZ: manage-gated like every other creator route — an editor
 *    (workspace:write, no manage) gets 403 forbidden_scope, not a leaky 404.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';

let BASE: string;
let server: http.Server;

const CB = '/v1/host/openwop-app/kicktodo/creator';
const FACTORY_ID = 'openwop-app.kicktodo.challenge-factory';

interface AuthorRead {
  agentId: string;
  rosterId: string;
  label: string;
  autonomyLevel?: string;
  workflows: Array<{ workflowId: string; available: boolean; nodeCount: number }>;
}

function client() {
  let cookie = '';
  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers)) {
      const m = /(__session=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
    return res;
  };
  return {
    get: (p: string) => send('GET', p),
    login: async (subject: string, tenantId: string) => {
      const res = await send('POST', '/v1/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
    },
  };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  for (const id of ['users', 'kicktodo-core', 'kicktodo-creator']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('ADR 0461 — the author read provisions eagerly and reports the roster truth', () => {
  it('first touch on a fresh tenant returns the deterministic author + catalog-verified factory portfolio', async () => {
    const creator = client();
    await creator.login('user:author-read-fresh', 'tenant-kt-author-read');
    const res = await creator.get(`${CB}/author`);
    expect(res.status).toBe(200);
    const body = await res.json() as AuthorRead;
    expect(body.agentId).toBe('feature.kicktodo.agents.challenge-author');
    expect(body.rosterId).toBe('host:challenge-author');
    expect(body.label).toBe('Challenge Author');
    // ADR 0461 OQ1 — the provisioning saga pins autonomy to 'review'.
    expect(body.autonomyLevel).toBe('review');
    const factory = body.workflows.find((w) => w.workflowId === FACTORY_ID);
    expect(factory).toBeDefined();
    // Catalog-verified honesty: the builtin resolves with its real node count.
    expect(factory!.available).toBe(true);
    expect(factory!.nodeCount).toBeGreaterThan(0);
  });

  it('is idempotent — a second read converges on the same roster instance', async () => {
    const creator = client();
    await creator.login('user:author-read-fresh', 'tenant-kt-author-read');
    const a = await (await creator.get(`${CB}/author`)).json() as AuthorRead;
    const b = await (await creator.get(`${CB}/author`)).json() as AuthorRead;
    expect(b.rosterId).toBe(a.rosterId);
    expect(b.workflows).toEqual(a.workflows);
  });
});

describe('ADR 0461 — the author read is manage-gated', () => {
  let wsTenant: string;
  let editorCookie: string;
  let adminCookie: string;

  const craftCookie = (userId: string, activeTenant: string, personalTenant: string): string => {
    const now = Math.floor(Date.now() / 1000);
    return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: activeTenant, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
  };
  const seatMember = async (principalId: string, roles: string[], personalTenant: string): Promise<string> => {
    const user = await upsertFromPrincipal({ tenantId: wsTenant, principalId, source: 'oidc' });
    await createMember({ tenantId: wsTenant, orgId: wsTenant, subject: user.userId, displayName: principalId, roles });
    return craftCookie(user.userId, wsTenant, personalTenant);
  };

  beforeAll(async () => {
    const ws = await createWorkspace({ name: 'KT Author Read', ownerSubject: 'oidc:ar-owner' });
    wsTenant = ws.tenantId;
    editorCookie = await seatMember('oidc:ar-editor', ['editor'], 'ws:home-ar-editor');
    adminCookie = await seatMember('oidc:ar-admin', ['admin'], 'ws:home-ar-admin');
  });

  it('an editor (workspace:write, NO manage) gets 403 forbidden_scope — not a leaky 404', async () => {
    const res = await fetch(`${BASE}${CB}/author`, { headers: { cookie: editorCookie } });
    expect(res.status).toBe(403);
    const body = await res.json().catch(() => undefined) as { error?: string; code?: string } | undefined;
    expect((body?.error ?? body?.code ?? '')).toContain('forbidden_scope');
  });

  it('an admin (host:kicktodo:manage) gets 200', async () => {
    const res = await fetch(`${BASE}${CB}/author`, { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
  });
});
