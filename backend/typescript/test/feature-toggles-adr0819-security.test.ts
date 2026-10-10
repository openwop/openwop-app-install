/**
 * ADR 0819 — feature-toggle control-plane security, over real HTTP.
 *
 * Each case was written RED against `origin/main` source before the fix:
 *  - S1  the ADR 0419 plan paywall lives in `requireFeatureEnabled` (the HTTP
 *        choke) only, so a sellable feature's AGENT TOOLS answered a tenant whose
 *        plan does not include it — the chat lane walked around the paywall.
 *  - S2  the environments config-domain wrote `tenantOverrides[tenant]` for any
 *        holder of `host:members:manage`, so a tenant re-applying an old snapshot
 *        undid an operator's per-tenant decision (restored a revoked `on`, or
 *        cleared an operator `off`). Per-tenant overrides are an operator lever.
 *  - S4  a flip was audited as the TENANT (`updatedBy: req.tenantId`) and only to
 *        the log stream, so "who turned this off" had no durable answer.
 *  - S5  the admin PUT blind-replaced the stored row, so an editor holding a
 *        stale read wiped a per-tenant override written in between.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig, enableTenantOverride, resolveOne } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { STRATEGY_LIST_TOOL_ID } from '../src/features/strategy/agentTools.js';
import { PM_LIST_LISTS_TOOL_ID } from '../src/features/priority-matrix/agentTools.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';

let BASE: string;
let server: http.Server;

const OPERATOR_TENANT = 'user:adr0819-operator';
const OPERATOR_SUBJECT = 'oidc:adr0819-operator';
const VICTIM_TENANT = 'user:adr0819-tenant';
const VICTIM_SUBJECT = 'oidc:adr0819-tenant';

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
    post: (p: string, b?: unknown) => send('POST', p, b ?? {}),
    put: (p: string, b?: unknown) => send('PUT', p, b ?? {}),
    del: (p: string) => send('DELETE', p),
    login: async (subject: string, tenantId: string) => {
      const res = await send('POST', '/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
    },
  };
}

const setGlobal = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle default: ${id}`);
  await saveConfig({ ...d, status }, 'test');
};

const ADMIN = '/host/openwop-app/feature-toggles/admin/configs';
const ENV = '/host/openwop-app/environments';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR_TENANT;
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  // Narrow the plan so NO bundle feature is entitled (billing on) — the
  // `entitlement-central-gate.test.ts` shape; plan config is read at boot.
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_lead: 'leadership' });
  // ADR 0820 §8: `environments` is now a sellable (governance) bundle feature. S2 is about the
  // override restore, not the paywall, so the narrowed plan includes it.
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing', 'environments'], pro: ['billing', 'environments'] });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  for (const id of ['billing', 'environments', 'strategy', 'priority-matrix']) await setGlobal(id, 'on');
});

afterAll(async () => {
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  delete process.env.OPENWOP_BILLING_BUNDLE_PRICES;
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('S1 — the plan paywall holds at the agent-tool exit, not only the HTTP route', () => {
  it('the HTTP route refuses the unentitled tenant (the baseline the tools must match)', async () => {
    const c = client();
    await c.login('oidc:adr0819-s1', 'user:adr0819-s1');
    const res = await c.get('/host/openwop-app/strategy');
    expect(res.status).toBe(403);
  });

  it('a sellable feature\'s read tools refuse the same tenant', async () => {
    const provider = createAgentToolProvider({ tenantId: 'user:adr0819-s1', actingUserId: 'oidc:adr0819-s1' });
    for (const name of [STRATEGY_LIST_TOOL_ID, PM_LIST_LISTS_TOOL_ID]) {
      const out = await provider.executeTool({ name, input: {} });
      const body = JSON.parse(out.content) as Record<string, unknown>;
      expect(out.isError, `${name}: ${out.content}`).toBe(true);
      expect(['feature_disabled', 'not_entitled']).toContain(body.error);
    }
    // Positive control: the operator's tenant is entitled to everything, so the
    // SAME tools serve it. Without this a tool that refused for any reason passes.
    const entitled = createAgentToolProvider({ tenantId: OPERATOR_TENANT, actingUserId: OPERATOR_SUBJECT });
    for (const name of [STRATEGY_LIST_TOOL_ID, PM_LIST_LISTS_TOOL_ID]) {
      const out = await entitled.executeTool({ name, input: {} });
      expect(out.isError, `${name}: ${out.content}`).toBeFalsy();
    }
  });

  it('a workflow node reaching the feature through ctx.features is refused the same way', async () => {
    const surfaces = buildFeatureSurfaces({ tenantId: 'user:adr0819-s1' } as Parameters<typeof buildFeatureSurfaces>[0]);
    const listLists = surfaces['priority-matrix']?.listLists;
    expect(listLists).toBeDefined();
    await expect(listLists!({})).rejects.toMatchObject({ code: 'host_capability_disabled' });
    const entitled = buildFeatureSurfaces({ tenantId: OPERATOR_TENANT } as Parameters<typeof buildFeatureSurfaces>[0]);
    await expect(entitled['priority-matrix']!.listLists!({})).resolves.toBeDefined();
  });
});

describe('S2 — a tenant cannot rewrite the operator\'s per-tenant override through an environments restore', () => {
  it('re-applying an old snapshot does not restore an override the operator revoked', async () => {
    await setGlobal('walkthroughs', 'off');
    // The operator (demo provisioning) enables `dealers` for this tenant only.
    expect(await enableTenantOverride('walkthroughs', VICTIM_TENANT, 'operator')).toBe('enabled');
    // Positive control, and why these ids are NOT sold in a bundle: the suite
    // narrows the plan, so a sellable id would resolve off from the plan alone
    // and the assertions below would hold with or without the fix (review H3).
    expect((await resolveOne('walkthroughs', { tenantId: VICTIM_TENANT }))?.enabled).toBe(true);

    const tenant = client();
    await tenant.login(VICTIM_SUBJECT, VICTIM_TENANT);
    const snap = await tenant.post(`${ENV}/snapshots`);
    expect(snap.status).toBe(201);
    const { hash } = (await snap.json()) as { hash: string };

    // The operator revokes it through the superadmin surface.
    const op = client();
    await op.login(OPERATOR_SUBJECT, OPERATOR_TENANT);
    const cur = (await (await op.get(`${ADMIN}/walkthroughs`)).json()) as Record<string, unknown>;
    const revoke = await op.put(`${ADMIN}/walkthroughs`, { ...cur, tenantOverrides: {} });
    expect(revoke.status).toBe(200);
    expect((await resolveOne('walkthroughs', { tenantId: VICTIM_TENANT }))?.enabled).toBe(false);

    // The tenant re-applies the snapshot it took while the override existed.
    // The apply must SUCCEED; a refused apply would make the assertion below vacuous.
    expect((await tenant.post(`${ENV}/apply`, { snapshotHash: hash })).status).toBe(200);
    expect((await resolveOne('walkthroughs', { tenantId: VICTIM_TENANT }))?.enabled).toBe(false);
  });

  it('re-applying an old snapshot does not clear an operator "off" for the tenant', async () => {
    await setGlobal('forms', 'on');
    expect((await resolveOne('forms', { tenantId: VICTIM_TENANT }))?.enabled).toBe(true);
    const tenant = client();
    await tenant.login(VICTIM_SUBJECT, VICTIM_TENANT);
    const snap = await tenant.post(`${ENV}/snapshots`);
    const { hash } = (await snap.json()) as { hash: string };

    const op = client();
    await op.login(OPERATOR_SUBJECT, OPERATOR_TENANT);
    const cur = (await (await op.get(`${ADMIN}/forms`)).json()) as Record<string, unknown>;
    const kill = await op.put(`${ADMIN}/forms`, { ...cur, tenantOverrides: { [VICTIM_TENANT]: { status: 'off' } } });
    expect(kill.status).toBe(200);
    expect((await resolveOne('forms', { tenantId: VICTIM_TENANT }))?.enabled).toBe(false);

    expect((await tenant.post(`${ENV}/apply`, { snapshotHash: hash })).status).toBe(200);
    expect((await resolveOne('forms', { tenantId: VICTIM_TENANT }))?.enabled).toBe(false);
  });
});

describe('S4 — every flip is durably audited with the acting PERSON', () => {
  it('a superadmin PUT and DELETE each append an audit row naming the principal', async () => {
    const op = client();
    await op.login(OPERATOR_SUBJECT, OPERATOR_TENANT);
    const cur = (await (await op.get(`${ADMIN}/webinars`)).json()) as Record<string, unknown>;
    expect((await op.put(`${ADMIN}/webinars`, { ...cur, status: 'beta', betaCohort: ['oidc:cohort-person-0819'] })).status).toBe(200);
    expect((await op.del(`${ADMIN}/webinars`)).status).toBe(200);
    const rows = await hostExtStorage().listAudit({ actionPrefix: 'feature-toggle.', resource: 'webinars' });
    const save = rows.find((r) => r.action === 'feature-toggle.saved');
    expect(save, JSON.stringify(rows)).toBeDefined();
    // The PERSON (the session's principal), not the workspace they acted in.
    // On origin/main `updatedBy` was the tenant id, and no row existed at all.
    expect(save?.principalId).toBeTruthy();
    expect(save?.principalId).not.toBe(OPERATOR_TENANT);
    const revert = rows.find((r) => r.action === 'feature-toggle.reverted');
    expect(revert?.principalId).toBe(save?.principalId);
    // audit_log is global and never erased: a cohort member's id must not land in it.
    expect(JSON.stringify(rows)).not.toContain('cohort-person-0819');
  });
});

describe('S5 — an admin save from a stale read is refused, not a silent overwrite', () => {
  it('a PUT carrying a superseded revision is 409 and the concurrent override survives', async () => {
    await setGlobal('forms', 'off');
    const op = client();
    await op.login(OPERATOR_SUBJECT, OPERATOR_TENANT);
    const stale = (await (await op.get(`${ADMIN}/forms`)).json()) as Record<string, unknown>;
    // A concurrent writer (demo provisioning) lands a per-tenant override.
    expect(await enableTenantOverride('forms', 'user:adr0819-s5', 'operator')).toBe('enabled');
    const res = await op.put(`${ADMIN}/forms`, { ...stale, status: 'beta' });
    expect(res.status).toBe(409);
    // The machine reason the panel keys its "reload this toggle" recovery on.
    expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe('revision_conflict');
    expect((await resolveOne('forms', { tenantId: 'user:adr0819-s5' }))?.enabled).toBe(true);
  });
});
