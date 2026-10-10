/**
 * Shared harness for the ADR 0820 G2–G5 paywall-gate tests
 * (`monetization-g{2,3,4,5}-*.test.ts`).
 *
 * The plan is narrowed so FREE_TENANT has `documents` (and billing) but NONE of
 * the editor / canvas / marketing / sales bundles, and every feature involved is
 * toggled ON globally, so a refusal is the PLAN half of `resolveOne` — the half
 * these lanes skipped. OPERATOR_TENANT is the positive control: the tenant
 * entitlement check grants a listed superadmin tenant everything, so a gate that
 * refused for any reason, or a capability that was simply broken, cannot pass.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';

export const OPERATOR_TENANT = 'org:mz-b1-operator';
export const FREE_TENANT = 'org:mz-b1-free';

const FEATURES_ON = [
  'users', 'crm', 'sales-commissions', 'slides', 'cad', 'drawings', 'campaign-studio', 'app-builder',
  'documents', 'sharing', 'code-export', 'code-publish', 'code-sync', 'campaign-channels', 'campaign-connectors',
  'creative-video', 'creative-briefs', 'campaign-brief', 'billing',
];

let BASE = '';
let server: http.Server | undefined;
let n = 0;

/** Boot the app once for the calling test file, with the narrowed plan. */
export function useMonetizationHarness(): void {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR_TENANT;
    delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_DEMO_MODE;
    // The `feature-toggles-adr0819-security.test.ts` shape: billing on, a narrowed
    // plan. `documents` is in the plan so the documents route itself admits the
    // free tenant and the canvas-type gate is the thing under test.
    process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_lead: 'leadership' });
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing', 'documents'], pro: ['billing', 'documents'] });
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`; res(); }); });
    for (const id of FEATURES_ON) {
      const d = getToggleDefault(id);
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
  }, 60_000);

  afterAll(async () => {
    delete process.env.OPENWOP_TEST_AUTH_ENABLED;
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    delete process.env.OPENWOP_BILLING_BUNDLE_PRICES;
    delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
    if (server) await new Promise<void>((res) => server!.close(() => res()));
  });
}

export interface Res { status: number; body: any }
export interface Member { userId: string; orgId: string; post: (p: string, b?: unknown) => Promise<Res> }

const members = new Map<string, Promise<Member>>();

/** The logged-in owner of an org in `tenantId` (one per tenant per file: only
 *  the tenant's first user may create an org there). */
export function workspace(tenantId: string): Promise<Member> {
  let m = members.get(tenantId);
  if (!m) { m = newWorkspace(tenantId); members.set(tenantId, m); }
  return m;
}

async function newWorkspace(tenantId: string): Promise<Member> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  const login = await call('POST', '/host/openwop-app/test/login', { email: `owner-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await call('POST', '/host/openwop-app/orgs', { name: `Acme ${n++}` });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { userId: login.body.user.userId, orgId: org.body.orgId, post: (p, b) => call('POST', p, b) };
}

export type NodeSeen = { ok: true; value: unknown } | { ok: false; code: string };

/** Run ONE node through the real executor and report what its body saw. */
export async function runNode(tenantId: string, typeId: string, body: (ctx: any) => Promise<unknown>): Promise<NodeSeen> {
  const { openStorage } = await import('../src/storage/index.js');
  const { executeRun } = await import('../src/executor/executor.js');
  let seen: NodeSeen = { ok: false, code: 'node_never_ran' };
  getNodeRegistry().register({
    typeId,
    version: '1.0.0',
    async execute(ctx: any) {
      try { seen = { ok: true, value: await body(ctx) }; } catch (e: any) { seen = { ok: false, code: String(e?.code ?? 'error') }; }
      return { status: 'success', outputs: {} };
    },
  } as never);
  const storage = await openStorage('memory://');
  const now = new Date().toISOString();
  const run = { runId: `run-mzb1-${n++}-${Math.random().toString(36).slice(2, 8)}`, workflowId: 'wf.test.mzb1', tenantId, status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
  await storage.insertRun(run as never);
  await executeRun(storage, run as never, { workflowId: 'wf.test.mzb1', nodes: [{ nodeId: 'n', typeId }] } as never, { policyResolver: { async resolveForRun() { return []; } } } as never);
  return seen;
}
