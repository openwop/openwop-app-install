/**
 * ADR 0434 (KTFULL-B2/B15) — the Factory + Metrics route tables are privileged
 * AT THE HTTP BOUNDARY, proven by driving them, not by reading their source.
 *
 * `kicktodo-authz-adversarial.test.ts` asserted these two tables with
 * `expect(String(route.handler)).toContain('gate')`. That substring is satisfied
 * by an `authoringGate`, by a participant/open gate, by the word inside a comment,
 * and by `{ gate: err.gate }` in an error envelope — so a route added with NO
 * authorization at all could pass, which is precisely the class the ADR 0434 audit
 * found (five packages gating on "toggle + identified caller" only). The docblock
 * there even claimed it "fails loudly if someone adds a route with the participant
 * gate by mistake"; it does not.
 *
 * This suite sweeps EVERY route in both tables from the attacker's side: an editor
 * seated in a shared workspace they do NOT own (so `isOwnPersonalWorkspace` cannot
 * short-circuit the gate) must be refused with `forbidden_scope`, specifically —
 * a `feature_disabled` or a validation error would mean the sweep proved nothing
 * about authorization, so the toggles are enabled first and the CODE is asserted.
 *
 * Non-vacuity is proven in-suite: the same requests as an ADMIN must NOT 403.
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
import { KICKTODO_CREATOR_ROUTES } from '../src/features/kicktodo-creator/routes.js';
import { KICKTODO_METRICS_ROUTES } from '../src/features/kicktodo-metrics/routes.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let editorCookie: string;
let adminCookie: string;

/** A user-tier session whose ACTIVE tenant is the shared workspace while the
 *  caller's PERSONAL tenant is elsewhere — the only shape that actually exercises
 *  `requireKicktodoManage` (see kicktodo-outline-canvas-authz.test.ts). */
function craftCookie(userId: string, activeTenant: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: activeTenant, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}

async function seatMember(principalId: string, roles: string[], personalTenant: string): Promise<string> {
  const user = await upsertFromPrincipal({ tenantId: TENANT, principalId, source: 'oidc' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: user.userId, displayName: principalId, roles });
  return craftCookie(user.userId, TENANT, personalTenant);
}

interface Probe { key: string; method: string; path: string }

/** Route paths carry only `:id`; a dummy is fine because authorization runs before
 *  the handler ever loads the row (a 404 instead of a 403 would itself be a finding). */
function probes(routes: readonly { method: string; path: string }[]): Probe[] {
  return routes.map((r) => ({
    key: `${r.method.toUpperCase()} ${r.path}`,
    method: r.method.toUpperCase(),
    path: r.path.replace(/:([A-Za-z0-9_]+)/g, 'probe-id'),
  }));
}

async function call(cookie: string, p: Probe): Promise<{ status: number; body: any }> {
  const sendsBody = p.method !== 'GET' && p.method !== 'DELETE';
  const res = await fetch(`${BASE}${p.path}`, {
    method: p.method,
    headers: { cookie, ...(sendsBody ? { 'content-type': 'application/json' } : {}) },
    ...(sendsBody ? { body: '{}' } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

const CREATOR = probes(KICKTODO_CREATOR_ROUTES);
const METRICS = probes(KICKTODO_METRICS_ROUTES);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // The toggles MUST be on: a `feature_disabled` refusal would make every
  // assertion below pass while proving nothing about the scope check.
  for (const id of ['users', 'kicktodo-core', 'kicktodo-creator', 'kicktodo-metrics']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const ws = await createWorkspace({ name: 'KT Studio', ownerSubject: 'oidc:kt-owner' });
  TENANT = ws.tenantId;
  editorCookie = await seatMember('oidc:kt-editor', ['editor'], 'ws:home-editor');
  adminCookie = await seatMember('oidc:kt-admin', ['admin'], 'ws:home-admin');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('the sweep covers a real, non-empty route surface', () => {
  it('both tables are non-empty (an empty loop would assert nothing)', () => {
    expect(CREATOR.length).toBeGreaterThan(0);
    expect(METRICS.length).toBeGreaterThan(0);
  });
});

describe('KTFULL-B2 — EVERY Factory route refuses an editor with forbidden_scope', () => {
  it.each(CREATOR)('$key', async (p) => {
    const r = await call(editorCookie, p);
    expect(r.status, `${p.key} must be privileged`).toBe(403);
    // The CODE is the discriminator: a toggle refusal or a validation error would
    // be a 403/400 for the wrong reason and must not count as authorization.
    expect(r.body?.error ?? r.body?.code, `${p.key} must refuse on SCOPE`).toContain('forbidden_scope');
  });
});

describe('KTFULL-B15 — EVERY Metrics route refuses an editor with forbidden_scope', () => {
  it.each(METRICS)('$key', async (p) => {
    const r = await call(editorCookie, p);
    expect(r.status, `${p.key} must be privileged`).toBe(403);
    expect(r.body?.error ?? r.body?.code, `${p.key} must refuse on SCOPE`).toContain('forbidden_scope');
  });
});

describe('non-vacuity — the same requests as an admin are NOT scope-refused', () => {
  /**
   * Asserts PRESENCE, not just absence. The first cut collected only
   * `status === 403 && forbidden_scope` and expected `[]`; that DOES catch a
   * scope-less admin (probed: seating `oidc:kt-admin` with `['editor']` fails it
   * on 21 routes). What it could not catch is the session itself breaking — a
   * 401 is not a 403, so every request failing authentication would have read as
   * "never scope-refused" and passed.
   *
   * So the check is now positive: every route must come back with a status that
   * could only have come from PAST the gate, and the count must equal the number
   * of routes probed.
   *
   * Probe note: replacing the cookie with a garbage value is NOT a valid probe
   * here — an unparseable session falls back to an anonymous caller acting in
   * its own personal workspace, which `isOwnPersonalWorkspace` legitimately lets
   * through. It stays green for a correct reason. Strip the ROLE, not the cookie.
   */
  it('an admin (host:kicktodo:manage) reaches the handler on every route in both tables', async () => {
    const blocked: string[] = [];
    const reached: string[] = [];
    for (const p of [...CREATOR, ...METRICS]) {
      const r = await call(adminCookie, p);
      // 401 = the session never authenticated; 403 = authorization refused.
      // Anything else (200/201/400/404/409/422) means the gate let it through —
      // a 404 on `probe-id` or a 400 on an empty body is exactly what we want.
      if (r.status === 401 || r.status === 403) blocked.push(`${p.key} -> ${r.status} ${String(r.body?.error ?? r.body?.code ?? '')}`);
      else reached.push(p.key);
    }
    expect(blocked, 'an admin holding the scope must never be refused at the gate').toEqual([]);
    expect(reached.length, 'no route was reached — the admin session is not what this suite thinks it is').toBe(CREATOR.length + METRICS.length);
  });
});
