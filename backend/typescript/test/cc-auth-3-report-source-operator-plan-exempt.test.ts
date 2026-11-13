/**
 * CC-AUTH-3 — client-report section sources honour the listed operator's plan
 * exemption (ADR 1108), and refuse a plan-blocked customer as a PLAN refusal.
 *
 * Observed live on app.openwop.dev (build 373d4863a, 2026-11-12 02:12–02:16Z):
 * the listed operator, in a workspace on the free plan, added a client in
 * Campaign Studio → Operations and created a report. "Compute report" answered
 * 409 "A reporting source is unavailable for this workspace." and the
 * client-report chain (run f5afb88a…) failed in 387 ms the same way. The
 * operator's own assignments showed campaign-connectors / campaign-intel
 * enabled. Mechanism: `requireReportSource(featureId, tenantId)` resolved
 * access with NO subject, so `planExempt` never reached `resolveOne` and the
 * workspace's plan applied — the CC-AUTH-1 defect class in a lane that fix did
 * not reach.
 *
 * Lanes: the HTTP compute route (`POST …/report-definitions/:id/reports`) and the
 * run lane (`ctx.features['campaign-ops'].computeReportSnapshot`, what the
 * client-report chain's compute step calls).
 *
 * Controls: a customer in the SAME free workspace is still refused, now with
 * plan wording (`not_entitled`) instead of "unavailable"; a run scope whose
 * stamp is not backed by a listed person is refused; a source switched OFF is
 * still the 409 `report_source_unavailable` for the operator too.
 *
 * Sabotage witnesses (each turns a named test red):
 * - drop the subject from `requireReportSource`'s `featureAccessRefusal` call →
 *   "the listed operator computes a report" + "a run lane stamped for the operator";
 * - map a plan refusal back to the generic 409 → "customer … plan refusal".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { resolveCanonicalUserForTenant, upsertFromPrincipal } from '../src/features/users/usersService.js';
import { persistRecords } from '../src/features/campaign-connectors/performanceService.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import type { ReportDefinition } from '../src/features/campaign-ops/reports/types.js';

const OPERATOR_PERSONAL = 'user:ccauth3-operator';
const CUSTOMER_PERSONAL = 'user:ccauth3-customer';

let BASE: string;
let server: http.Server;
let TENANT: string;
let operatorUserId: string;
let customerUserId: string;
let adminCookie: string;
let operatorCookie: string;
let customerCookie: string;
let orgA: string;
const saved: Record<string, string | undefined> = {};
const ENV = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  OPENWOP_SUPERADMIN_TENANTS: OPERATOR_PERSONAL,
  // A narrowed plan: the marketing bundle (campaign-connectors, campaign-intel)
  // is sold, so a free workspace is not entitled to it.
  OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_mktg: 'marketing' }),
  OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify({ free: ['billing'], pro: ['billing'] }),
};

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}
interface Res<T> { status: number; body: T; raw: string }
async function call<T = Record<string, unknown>>(cookie: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}/host/openwop-app/campaign-ops${path}`, {
    method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}
const row = (date: string, spend: number, clicks: number, conversions: number) => ({
  platform: 'meta' as const, campaignName: 'Q4', adSet: 'A', date, spend, impressions: clicks * 20, clicks, conversions, revenue: conversions * 50,
  ctr: 0.05, cpc: spend / clicks, cvr: 0, cpa: 0, roas: 0, currency: 'USD',
});
const DEF = { title: 'Monthly results', sections: [{ kind: 'kpi' }, { kind: 'attribution' }], period: { kind: 'month', timezone: 'UTC' } };
type Err = { error?: string; message?: string; details?: { reason?: string; featureId?: string; feature?: string } };

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'campaign-ops', 'campaign-ops.client-reports', 'email', 'campaign-connectors', 'campaign-intel', 'campaign-orchestration', 'billing']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const ws = await createWorkspace({ name: 'Free Agency', ownerSubject: 'oidc:ccauth3-owner' });
  TENANT = ws.tenantId;
  const admin = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:ccauth3-admin', source: 'oidc' });
  // A `user:` personal tenant (the shape the operator listing needs) resolves the
  // caller to the canonical user keyed by that home tenant — grant THAT user.
  const operator = await resolveCanonicalUserForTenant({ homeTenant: OPERATOR_PERSONAL, principalId: OPERATOR_PERSONAL, source: 'oidc' });
  const customer = await resolveCanonicalUserForTenant({ homeTenant: CUSTOMER_PERSONAL, principalId: CUSTOMER_PERSONAL, source: 'oidc' });
  operatorUserId = operator.userId;
  customerUserId = customer.userId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin.userId, displayName: 'Admin', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: operator.userId, displayName: 'Operator', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: customer.userId, displayName: 'Customer', roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: customer.userId, displayName: 'Customer', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: operator.userId, displayName: 'Operator', roles: ['editor'] });
  adminCookie = cookieFor(admin.userId, 'ws:home-ccauth3-admin');
  operatorCookie = cookieFor(operator.userId, OPERATOR_PERSONAL);
  customerCookie = cookieFor(customer.userId, CUSTOMER_PERSONAL);
  const added = await call(adminCookie, 'POST', '/clients', { name: 'Client A', orgId: orgA });
  expect(added.status, added.raw).toBe(201);
  await persistRecords(TENANT, orgA, [row('2026-09-01', 120.5, 40, 3)], 'csv');
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

async function definition(cookie: string): Promise<string> {
  const d = await call<{ definition: ReportDefinition }>(cookie, 'POST', `/clients/${orgA}/report-definitions`, DEF);
  expect(d.status, d.raw).toBe(201);
  return d.body.definition.definitionId;
}

describe('CC-AUTH-3 — HTTP compute route', () => {
  it('the listed operator computes a report in a FREE workspace (sources resolve with the exemption)', async () => {
    const id = await definition(operatorCookie);
    const r = await call<{ report: { status: string; snapshot: { metrics: Record<string, { value: number | null }> } } }>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions/${id}/reports`, { periodStart: '2026-09-01', periodEnd: '2026-09-30' });
    expect(r.status, r.raw).toBe(201);
    expect(r.body.report.status).toBe('draft');
    expect(r.body.report.snapshot.metrics['kpi.spend']?.value).toBe(120.5);
  });

  it('control: a customer in the SAME free workspace is refused as a plan refusal, not "unavailable"', async () => {
    const id = await definition(customerCookie);
    const r = await call<Err>(customerCookie, 'POST', `/clients/${orgA}/report-definitions/${id}/reports`, {});
    expect(r.status, r.raw).toBe(403);
    expect(r.body.details).toMatchObject({ reason: 'not_entitled', featureId: 'campaign-connectors' });
    expect(r.body.message).toContain("not included in this workspace's plan");
  });

  it('control: a source switched OFF is still a 409 report_source_unavailable for the operator', async () => {
    const id = await definition(operatorCookie);
    const config = getToggleDefault('campaign-intel')!;
    try {
      await saveConfig({ ...config, status: 'off' }, 'test');
      const r = await call<Err>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions/${id}/reports`, {});
      expect(r.status, r.raw).toBe(409);
      expect(r.body.details).toMatchObject({ reason: 'report_source_unavailable', featureId: 'campaign-intel' });
    } finally { await saveConfig({ ...config, status: 'on' }, 'test'); }
  });
});

describe('CC-AUTH-3 — run lane (the client-report chain compute step)', () => {
  const surface = (scope: Parameters<typeof buildFeatureSurfaces>[0]) => buildFeatureSurfaces(scope)['campaign-ops']!;

  it('a run lane stamped for the listed operator computes the snapshot', async () => {
    const id = await definition(operatorCookie);
    const out = await surface({ tenantId: TENANT, runId: 'run-ccauth3-op', actingUserId: operatorUserId, personalTenant: OPERATOR_PERSONAL, planExempt: true })
      .computeReportSnapshot!({ orgId: orgA, definitionId: id, periodStart: '2026-09-01', periodEnd: '2026-09-30' }) as { snapshot: { metrics: Record<string, { value: number | null }> } };
    expect(out.snapshot.metrics['kpi.spend']?.value).toBe(120.5);
  });

  it('control: a stamp whose person is not listed grants nothing (plan refusal)', async () => {
    const id = await definition(customerCookie);
    await expect(surface({ tenantId: TENANT, runId: 'run-ccauth3-cu', actingUserId: customerUserId, personalTenant: CUSTOMER_PERSONAL, planExempt: true })
      .computeReportSnapshot!({ orgId: orgA, definitionId: id, periodStart: '2026-09-01', periodEnd: '2026-09-30' }))
      .rejects.toMatchObject({ details: { reason: 'not_entitled', featureId: 'campaign-connectors' } });
  });
});
