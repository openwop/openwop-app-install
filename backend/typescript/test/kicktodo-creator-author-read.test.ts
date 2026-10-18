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
 *
 * Honest ceiling (w41): "a second read converges on the same instance" cannot be
 * broken by a provisioning sabotage — the roster id is deterministic
 * (`host:challenge-author`) behind the roster's insert-if-absent CAS, so ONE row
 * holds by construction. The single-flight and catch-converge guards behind it
 * are witnessed in `kicktodo-challenge-author-provision.test.ts`.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { listRoster } from '../src/host/rosterService.js';
import { buildChainBackedDefinition } from '../src/host/chainBackedWorkflows.js';

let BASE: string;
let server: http.Server;

const CB = '/host/openwop-app/kicktodo/creator';
const FACTORY_ID = 'openwop-app.kicktodo.challenge-factory';

/** Untyped JSON → a plain record, without a cast (w41 typing rule: no `as`). */
async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  const v: unknown = await res.json();
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`expected a JSON object (status ${res.status})`);
  return { ...v };
}
/** The object rows of an untyped array field. */
function rowsOf(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)) : [];
}

const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_DEMO_MODE'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

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
      const res = await send('POST', '/host/openwop-app/test/login', { subject, tenantId });
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
      const addr = server.address();
      BASE = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
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
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('ADR 0461 — the author read provisions eagerly and reports the roster truth', () => {
  it('first touch on a fresh tenant returns the deterministic author + catalog-verified factory portfolio', async () => {
    const creator = client();
    await creator.login('user:author-read-fresh', 'tenant-kt-author-read');
    const res = await creator.get(`${CB}/author`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.agentId).toBe('vendor.openwop-app.kicktodo.agents.challenge-author');
    expect(body.rosterId).toBe('host:challenge-author');
    expect(body.label).toBe('Challenge Author');
    // ADR 0461 OQ1 — the provisioning saga pins autonomy to 'review'.
    expect(body.autonomyLevel).toBe('review');
    const factory = rowsOf(body.workflows).find((w) => w.workflowId === FACTORY_ID);
    expect(factory).toBeDefined();
    // Catalog-verified honesty: the factory resolves with its REAL node count — the
    // shipped chain's expansion, read independently of the route.
    expect(factory?.available).toBe(true);
    expect(factory?.nodeCount).toBe(buildChainBackedDefinition(FACTORY_ID).nodes.length);
  });

  it('is idempotent — a second read converges on the same roster instance', async () => {
    // Its OWN tenant, so it does not ride on case 1's provisioning.
    const creator = client();
    await creator.login('user:author-read-twice', 'tenant-kt-author-read-2');
    const a = await bodyOf(await creator.get(`${CB}/author`));
    const b = await bodyOf(await creator.get(`${CB}/author`));
    expect(a.rosterId).toBe('host:challenge-author');
    expect(b.rosterId).toBe(a.rosterId);
    expect(b.workflows).toEqual(a.workflows);
    // ONE roster row for the role after two reads (by construction — see header).
    const authors = (await listRoster('tenant-kt-author-read-2')).filter((e) => e.roleKey === 'kicktodo-challenge-author');
    expect(authors).toHaveLength(1);
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
    const body = await bodyOf(res);
    expect(body.error).toBe('forbidden_scope');
    expect(body.message).toBe('Missing required scope: host:kicktodo:manage');
  });

  it('an admin (host:kicktodo:manage) gets 200', async () => {
    const res = await fetch(`${BASE}${CB}/author`, { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.rosterId).toBe('host:challenge-author');
    expect(body.agentId).toBe('vendor.openwop-app.kicktodo.agents.challenge-author');
  });
});
