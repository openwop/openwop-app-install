/**
 * CC-AUTH-4 — the campaign autopilot keeps the listed operator's plan exemption
 * from the launch route through to its drafting stage (ADR 1108).
 *
 * Observed live on app.openwop.dev (build 373d4863a, 2026-11-12 03:31:55Z):
 * the listed operator, in a free-plan workspace, launched the autopilot from
 * Campaign detail → Autopilot. `POST …/campaign-autopilot/campaigns/:id/launch`
 * answered 201 and the section said "The autopilot is running…", but run
 * e63186aa (`campaign-studio.autopilot`) failed at once: `forbidden` "This
 * workflow belongs to the campaign-orchestration feature, which is not included
 * in this workspace's plan." The route passed (the operator is exempt at the
 * HTTP edge); `launchAutopilot` started the spine with no exemption stamp, and
 * `startStageRun` started the drafting stage (a campaign-orchestration workflow)
 * without forwarding it, so the run-start gate refused the stage.
 *
 * Pins: the operator's launch stamps the spine `planExempt`, the spine
 * completes, and its drafting stage run exists with the stamp; control — a
 * customer in the same free workspace is refused at the launch route, up front.
 *
 * Sabotage witnesses: drop the stamp from the launch route ⇒ the spine carries
 * no `planExempt` and the stage is never started (red); drop
 * `forwardedPlanExemption` from `startStageRun` ⇒ the spine fails (red).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { resolveCanonicalUserForTenant } from '../src/features/users/usersService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { stageRunId } from '../src/features/campaign-autopilot/stageRun.js';
import { bareRunId } from './support/bareRunId.js';

const OPERATOR_PERSONAL = 'user:ccauth4-operator';
const CUSTOMER_PERSONAL = 'user:ccauth4-customer';
let BASE = '';
let server: http.Server;
let storage: Storage;
let TENANT = '';
let orgA = '';
let operatorUser = '';
let operatorCookie = '';
let customerCookie = '';
const saved: Record<string, string | undefined> = {};
const ENV = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  OPENWOP_SUPERADMIN_TENANTS: OPERATOR_PERSONAL,
  OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_mktg: 'marketing' }),
  OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify({ free: ['billing'], pro: ['billing'] }),
};

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}
async function launch(cookie: string, campaignId: string): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const res = await fetch(`${BASE}/host/openwop-app/campaign-autopilot/campaigns/${campaignId}/launch`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { /* keep raw */ }
  return { status: res.status, body, raw };
}
async function campaign(): Promise<string> {
  const brief = await createBrief(TENANT, orgA, operatorUser, {
    name: `Launch ${randomBytes(3).toString('hex')}`, productName: 'Widget', personaIds: ['p-1'], messaging: { primaryValueProp: 'Faster' },
    channels: [{ type: 'email_sequence', enabled: true, config: {} }],
  });
  return (await ensureDraftCampaign(TENANT, brief, operatorUser)).campaign.id;
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-orchestration', 'campaign-autopilot', 'campaign-brief', 'billing']) {
    const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  TENANT = (await createWorkspace({ name: 'Free Agency', ownerSubject: 'oidc:ccauth4-owner' })).tenantId;
  const operator = await resolveCanonicalUserForTenant({ homeTenant: OPERATOR_PERSONAL, principalId: OPERATOR_PERSONAL, source: 'oidc' });
  const customer = await resolveCanonicalUserForTenant({ homeTenant: CUSTOMER_PERSONAL, principalId: CUSTOMER_PERSONAL, source: 'oidc' });
  operatorUser = operator.userId;
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  for (const u of [operator.userId, customer.userId]) {
    await createMember({ tenantId: TENANT, orgId: TENANT, subject: u, displayName: 'Member', roles: ['viewer'] });
    await createMember({ tenantId: TENANT, orgId: orgA, subject: u, displayName: 'Member', roles: ['editor'] });
  }
  operatorCookie = cookieFor(operator.userId, OPERATOR_PERSONAL);
  customerCookie = cookieFor(customer.userId, CUSTOMER_PERSONAL);
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

describe('CC-AUTH-4 — autopilot launch in a free workspace', () => {
  it("the operator's launch runs: the spine is stamped, completes, and its drafting stage starts with the stamp", async () => {
    const id = await campaign();
    const r = await launch(operatorCookie, id);
    expect(r.status, r.raw).toBe(201);
    const spineId = bareRunId(String(r.body.runId));
    expect((await storage.getRun(spineId))?.metadata).toMatchObject({ planExempt: true, personalTenant: OPERATOR_PERSONAL });
    await vi.waitFor(async () => {
      expect(['completed', 'failed', 'cancelled']).toContain((await storage.getRun(spineId))?.status);
    }, { timeout: 15_000, interval: 50 });
    const spine = await storage.getRun(spineId);
    expect(spine?.status, JSON.stringify(spine?.error ?? null)).toBe('completed');
    const stage = await storage.getRun(stageRunId(TENANT, spineId, 'drafts'));
    expect(stage?.workflowId).toBe('campaign-studio.campaign-orchestration');
    expect(stage?.metadata).toMatchObject({ planExempt: true });
  });

  it('control: a customer in the same free workspace is refused at the launch route, up front', async () => {
    const id = await campaign();
    const r = await launch(customerCookie, id);
    expect(r.status, r.raw).toBe(403);
  });
});
