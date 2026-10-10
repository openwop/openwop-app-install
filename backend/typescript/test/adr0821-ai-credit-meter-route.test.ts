/**
 * ADR 0821 D1/D2/D4 — `GET …/billing/ai-credits`, the billing page's AI credit
 * meter. Tenant-wide AI spend per feature is admin-class, so the read rides the
 * ONE billing authority (`host:billing:manage`, ADR 0786 D5), in the SESSION's
 * tenant only.
 *
 * Authority legs use the ADR 0554 §P3 harness (see adr0711-byok-operator-gate):
 * `sharedWorkspace: true`, membership in the workspace-root org, created BEFORE
 * login — otherwise the personal short-circuit makes every 403 unfalsifiable.
 *
 * Pins:
 *   - an EDITOR (a real member: the member-level balance read answers 200) is
 *     refused 403 naming the scope; an ADMIN is served (positive control);
 *   - a caller who is NOT a member of the workspace is refused (cross-tenant);
 *   - the admin sees only the workspace's own rows (another tenant's spend never
 *     appears), converted server-side to credits;
 *   - honest-when-unconfigured: no plan `aiCreditsMonthly` ⇒ `monthly: null`,
 *     no ready managed key ⇒ `freeDaily: null` — never a fabricated zero cap.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { recordFeatureSpend } from '../src/host/managedCredits.js';
import { importBillingState } from '../src/features/billing/billingService.js';

const B = '/host/openwop-app/billing';
const ADMIN = 'oidc:meter-admin';
const EDITOR = 'oidc:meter-editor';
const OUTSIDER = 'oidc:meter-outsider';
const OTHER = 't-meter-other';
let server: http.Server;
let BASE = '';
let WS = '';

async function login(subject: string, tenantId: string, sharedWorkspace = true): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace }),
  });
  expect(res.status, 'test seam must mint a session').toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}
const get = (path: string, cookie: string) => fetch(`${BASE}${path}`, { headers: { cookie } });

interface Meter {
  freeDaily: unknown;
  monthly: { month: string; usedCredits: number; allowanceCredits: number } | null;
  balanceCredits: number;
  windowDays: number;
  topFeatures: Array<{ featureId: string; usedCredits: number; chargedCredits: number; calls: number }>;
  otherCredits: number;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_BILLING_TOKENS_PER_CREDIT = '1000';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_BILLING_PLAN_LIMITS;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('billing');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  const ws = await createWorkspace({ name: 'ADR 0821 meter workspace', ownerSubject: 'oidc:meter-owner' });
  WS = ws.orgId ?? ws.tenantId;
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: userIdFor(WS, ADMIN), roles: ['admin'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, EDITOR), roles: ['editor'] });

  await recordFeatureSpend({ tenantId: WS, featureId: 'chat', inputTokens: 3000, outputTokens: 1000, chargedTokens: 500 });
  await recordFeatureSpend({ tenantId: WS, featureId: 'cms', inputTokens: 1500, outputTokens: 500 });
  await recordFeatureSpend({ tenantId: OTHER, featureId: 'evals', inputTokens: 9_000_000, outputTokens: 0 });
  await importBillingState({ balances: [{ tenantId: WS, purchasedTokensTotal: 250_000, totalAvailable: 120_000, updatedAt: '2026-10-01T00:00:00.000Z' }] });
});

afterAll(async () => {
  for (const k of ['OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_BILLING_TOKENS_PER_CREDIT', 'OPENWOP_BILLING_PLAN_LIMITS']) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
});

describe('GET billing/ai-credits — authority', () => {
  it('fixture honesty: the editor IS a member (the member-level balance read answers 200)', async () => {
    expect((await get(`${B}/balance`, await login(EDITOR, WS))).status).toBe(200);
  });

  it('refuses an EDITOR with a 403 naming host:billing:manage', async () => {
    const res = await get(`${B}/ai-credits`, await login(EDITOR, WS));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('host:billing:manage');
  });

  it('a caller who is not a member of the workspace never reads its meter (cross-tenant)', async () => {
    // Under `sharedWorkspace: true` a NON-member is bounced to their own personal
    // tenant by the ADR 0015 re-check (see `authTestSeam.ts`), so the outcome is
    // either a refusal or THEIR OWN empty meter — never the workspace's figures.
    const res = await get(`${B}/ai-credits`, await login(OUTSIDER, WS));
    if (res.status === 200) {
      const m = await res.json() as Meter;
      expect(m.topFeatures).toEqual([]);
      expect(m.balanceCredits).toBe(0);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  it('serves an ADMIN the workspace\'s own meter, in credits, and no other tenant\'s spend', async () => {
    const res = await get(`${B}/ai-credits`, await login(ADMIN, WS));
    expect(res.status).toBe(200);
    const m = await res.json() as Meter;
    expect(m.balanceCredits).toBe(120);
    expect(m.windowDays).toBe(30);
    expect(m.topFeatures.map((f) => f.featureId)).toEqual(['chat', 'cms']);
    expect(m.topFeatures[0]).toMatchObject({ featureId: 'chat', usedCredits: 4, chargedCredits: 0.5, calls: 1 });
    expect(m.topFeatures.some((f) => f.featureId === 'evals')).toBe(false);
    expect(m.otherCredits).toBe(0);
  });

  it('a solo caller meters their OWN personal workspace (the short-circuit), never another tenant', async () => {
    const res = await get(`${B}/ai-credits`, await login('oidc:meter-solo', 'user:meter-solo', false));
    expect(res.status).toBe(200);
    const m = await res.json() as Meter;
    expect(m.topFeatures).toEqual([]);
    expect(m.balanceCredits).toBe(0);
  });
});

describe('GET billing/ai-credits — honest when unconfigured', () => {
  it('no plan allowance and no ready managed key ⇒ both legs null, not zero', async () => {
    const m = await (await get(`${B}/ai-credits`, await login(ADMIN, WS))).json() as Meter;
    expect(m.monthly).toBeNull();
    expect(m.freeDaily).toBeNull();
  });

  it('a plan aiCreditsMonthly is shown as the allowance, in credits', async () => {
    process.env.OPENWOP_BILLING_PLAN_LIMITS = JSON.stringify({ free: { aiCreditsMonthly: 750 } });
    try {
      const m = await (await get(`${B}/ai-credits`, await login(ADMIN, WS))).json() as Meter;
      expect(m.monthly).toMatchObject({ allowanceCredits: 750, usedCredits: 0 });
      expect(m.monthly?.month).toMatch(/^\d{4}-\d{2}$/);
    } finally {
      delete process.env.OPENWOP_BILLING_PLAN_LIMITS;
    }
  });
});
