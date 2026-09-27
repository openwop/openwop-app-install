/**
 * ADR 0396 — personal settings, ROUTE + enforcement:
 *   - GET/PUT /settings/prefs is SELF-SCOPED (two users in one tenant never
 *     see each other's prefs; the key is the authenticated user, never input);
 *   - validation typed-400s (cap bounds, warn pct, directive enum);
 *   - the personal BYOK budget lane: off-by-default (no `personal` verdict
 *     without a set cap), fail-closed hard block when the personal cap is
 *     reached, org lane independent, usage recorded per user;
 *   - the per-user reasoning-directive override resolves over the host
 *     posture and falls back when cleared (P4 precedence).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { checkByokChatBudget, recordByokChatUsage } from '../src/aiProviders/byokChatBudget.js';
import { resolveEnvelopeReasoning } from '../src/host/envelopeReasoningConfig.js';
import { getUserByokUsage, __resetSettingsStores } from '../src/features/settings/prefsStore.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { managedUsageBucket } from '../src/providers/managedUsageScope.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_BYOK_DAILY_TOKEN_CAP; // org lane uncapped — the personal lane is under test
  delete process.env.OPENWOP_ENVELOPE_REASONING_DIRECTIVE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('users');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

const PREFS = '/v1/host/openwop-app/settings/prefs';
let n = 0;
async function login(tenantId: string): Promise<{ c: Client; userId: string }> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `set-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: (r.body as { user: { userId: string } }).user.userId };
}

describe('settings prefs — self-scoping + validation', () => {
  it('round-trips prefs per user; two users in one tenant are isolated', async () => {
    const tenantId = `org:test-set-${Date.now()}`;
    const a = await login(tenantId);
    const b = await login(tenantId);

    expect((await a.c.get(PREFS)).body.personalBudget).toBeNull();
    const saved = await a.c.put(PREFS, { personalBudget: { dailyTokenCap: 5000, softWarningPct: 50 }, reasoningDirective: 'mandatory', privacy: { analyticsOptOut: true } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.personalBudget).toEqual({ dailyTokenCap: 5000, softWarningPct: 50 });

    // B sees NOTHING of A's prefs (self-scoped by the authenticated user).
    const bPrefs = await b.c.get(PREFS);
    expect(bPrefs.body.personalBudget).toBeNull();
    expect(bPrefs.body.reasoningDirective).toBeNull();

    // clearing: cap 0 (or null) removes the personal budget
    const cleared = await a.c.put(PREFS, { personalBudget: { dailyTokenCap: 0 } });
    expect(cleared.body.personalBudget).toBeNull();
  });

  it('validates typed-400s', async () => {
    const { c } = await login(`org:test-set-val-${Date.now()}`);
    expect((await c.put(PREFS, { personalBudget: { dailyTokenCap: -5 } })).status).toBe(400);
    expect((await c.put(PREFS, { personalBudget: { dailyTokenCap: 10, softWarningPct: 101 } })).status).toBe(400);
    expect((await c.put(PREFS, { reasoningDirective: 'sometimes' })).status).toBe(400);
  });
});

describe('personal BYOK budget lane (min() with the org backstop)', () => {
  it('off by default; hard-blocks fail-closed at the personal cap; usage recorded per user', async () => {
    await __resetSettingsStores();
    const tenantId = `org:test-budget-${Date.now()}`;
    const { c, userId } = await login(tenantId);

    // Off by default — no personal verdict without a set cap.
    const before = await checkByokChatBudget(tenantId, 'anthropic', userId);
    expect(before.personal).toBeUndefined();
    expect(before.exceeded).toBe(false); // org lane uncapped in this suite

    // Set a tiny personal cap, record usage past it (the post-dispatch path).
    expect((await c.put(PREFS, { personalBudget: { dailyTokenCap: 100, softWarningPct: 50 } })).status).toBe(200);
    await recordByokChatUsage(tenantId, 'anthropic', 80, 40, userId);
    const usage = await getUserByokUsage(tenantId, userId, new Date().toISOString().slice(0, 10));
    expect(usage.inputTokens + usage.outputTokens).toBe(120);

    const after = await checkByokChatBudget(tenantId, 'anthropic', userId);
    expect(after.personal).toMatchObject({ exceeded: true, used: 120, cap: 100 });
    // the ORG lane stays independent (uncapped) — a personal cap never raises
    // or replaces the backstop, it only adds a lower bound of its own
    expect(after.exceeded).toBe(false);

    // another user in the tenant is untouched (per-user accounting)
    const other = await login(tenantId);
    const otherCheck = await checkByokChatBudget(tenantId, 'anthropic', other.userId);
    expect(otherCheck.personal).toBeUndefined();
  });
});

describe('per-user reasoning-directive override (P4 precedence)', () => {
  it('override wins; clearing falls back to the host posture', async () => {
    const tenantId = `org:test-reason-${Date.now()}`;
    const { c, userId } = await login(tenantId);
    expect((await resolveEnvelopeReasoning(tenantId, userId)).promptDirective).toBe('advisory'); // host default
    await c.put(PREFS, { reasoningDirective: 'mandatory' });
    expect((await resolveEnvelopeReasoning(tenantId, userId)).promptDirective).toBe('mandatory');
    await c.put(PREFS, { reasoningDirective: null });
    expect((await resolveEnvelopeReasoning(tenantId, userId)).promptDirective).toBe('advisory');
    // no user context ⇒ host posture (system runs unchanged)
    expect((await resolveEnvelopeReasoning(tenantId, undefined)).promptDirective).toBe('advisory');
  });
});

describe('ADR 0693 phase 5 — the ROUTE reads the ACTIVE workspace bucket, not the home tenant', () => {
  // Measured on kicktodo.com 2026-09-16: two participants switched into the
  // shared `host-kicktodo` workspace both read `scope: 'tenant'`, tokens 0, from
  // GET /settings/prefs — the route composed the bucket from `user.tenantId`
  // (the caller's personal HOME tenant, single-principal by construction) while
  // every turn in the workspace is charged to `(activeTenant, actingUserId)`.
  // The service-level test (`managed-own-usage-read.test.ts`) could not see
  // this: it hands describeOwnManagedUsage the right tenant by hand.
  it('after switching into a real ws: workspace the figure follows the ACTIVE workspace', async () => {
    const { c, userId } = await login(`user:test-home-${Date.now()}-${n++}`);
    const day = new Date().toISOString().slice(0, 10);

    // At home (personal, single-principal): the tenant row, scope 'tenant'.
    const home = (await c.get(PREFS)).body.managedUsageToday as { tokens: number; scope: string } | null;
    expect(home, 'a managed target is configured in tests, so the figure is present').not.toBeNull();
    expect(home!.scope).toBe('tenant');

    const ws = await c.post('/v1/host/openwop-app/workspaces', { name: `Usage WS ${n++}` });
    expect(ws.status, JSON.stringify(ws.body)).toBe(201);
    const wsId = ws.body.workspaceId as string;
    expect(wsId).toMatch(/^ws:/);
    const sw = await c.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(wsId)}/switch`);
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);

    // The dispatcher's charge: (ACTIVE workspace, acting user) — runs.ts stamps
    // `req.userId ?? principalId` on every run.
    await hostExtStorage().incrementManagedUsage(managedUsageBucket(wsId, userId), 'openwop-free', day, 120, 30);

    const g = await c.get(PREFS);
    expect(g.status).toBe(200);
    const mu = g.body.managedUsageToday as { tokens: number; scope: string } | null;
    expect(mu!.scope, 'a shared workspace meters per subject').toBe('subject');
    expect(mu!.tokens, "the participant's OWN charge on the ACTIVE workspace — 0 here is the home-tenant read").toBe(150);
  });
});
