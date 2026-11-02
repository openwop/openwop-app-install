/**
 * ADR 0819 §3/§4/§5 — the control-plane additions, over real HTTP where the
 * behaviour lives at the boundary:
 *  - the kill switch beats every override and cohort, survives a round trip
 *    through the store and the admin projection, is refused by the disable-lock
 *    while a dependent is on, and is never "provisioned" around;
 *  - the revision precondition on DELETE;
 *  - the history route is superadmin-only;
 *  - a PUT for an undeclared toggle id is a 404, not an orphan row;
 *  - §1's restriction opt-out: a plan that EXCLUDES territories does NOT turn
 *    territory scoping permissive (re-aimed in grade-tests w70 from `consent`,
 *    which sits in no bundle, so no plan could ever exclude it);
 *  - TGWF-4: a USER-listed closed-beta member is served on the node lane.
 *
 * Tracker TST-DCA-1. Sabotage witnesses (grade-tests w70):
 *  - red when `resolveConfig` stops evaluating `killed` first, or the store drops it
 *  - red when the disable-lock ignores `next.killed`, or DELETE skips the revision
 *  - red when the history route drops `requireSuperadmin`, or PUT accepts an undeclared id
 *  - red when territory visibility resolves through the paywalled `resolveOne`
 *  - red when the public docs lane resolves through the paywalled `resolveOne` (404)
 *  - red when `ctx.features` drops the acting user from the subject (TGWF-4)
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { enableTenantOverride, resolveOne, saveConfig, getEffectiveConfig, getStoredConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { provisionDemoFeatures } from '../src/host/demoProvision.js';
import { filterVisibleCrmRecords } from '../src/host/crmRecordVisibility.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { createOrg } from '../src/host/accessControlService.js';

let BASE: string;
let server: http.Server;
const OPERATOR_TENANT = 'user:adr0819c-operator';

function client() {
  let cookie = '';
  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
    put: (p: string, b: unknown) => send('PUT', p, b),
    del: (p: string) => send('DELETE', p),
    login: async (subject: string, tenantId: string) => {
      const res = await send('POST', '/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
    },
  };
}

const ADMIN = '/host/openwop-app/feature-toggles/admin/configs';
const setGlobal = async (id: string, status: 'on' | 'off' | 'beta', extra: Record<string, unknown> = {}): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle default: ${id}`);
  await saveConfig({ ...d, status, ...extra }, 'test');
};

let op: ReturnType<typeof client>;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR_TENANT;
  process.env.OPENWOP_DEMO_SEED_ENABLED = 'true';
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_cdp: 'customer-data-platform' });
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'], pro: ['billing'] });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  await setGlobal('billing', 'on');
  op = client();
  await op.login('oidc:adr0819c-operator', OPERATOR_TENANT);
});

afterAll(async () => {
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  delete process.env.OPENWOP_BILLING_BUNDLE_PRICES;
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('§3 — the kill switch', () => {
  it('beats a per-tenant override, survives the round trip, and lifting it restores the override', async () => {
    await setGlobal('walkthroughs', 'off');
    expect(await enableTenantOverride('walkthroughs', 'user:k-1', 'operator')).toBe('enabled');
    expect((await resolveOne('walkthroughs', { tenantId: 'user:k-1' }))?.enabled).toBe(true);

    const cur = (await (await op.get(`${ADMIN}/walkthroughs`)).json()) as Record<string, unknown>;
    const killed = await op.put(`${ADMIN}/walkthroughs`, { ...cur, killed: true });
    expect(killed.status).toBe(200);
    const after = (await killed.json()) as Record<string, unknown>;
    expect(after.killed).toBe(true);
    // The stored choice, the effective config and the admin read all carry it.
    expect((await getEffectiveConfig('walkthroughs'))?.killed).toBe(true);
    expect(((await (await op.get(`${ADMIN}/walkthroughs`)).json()) as Record<string, unknown>).killed).toBe(true);
    expect((await resolveOne('walkthroughs', { tenantId: 'user:k-1' }))?.enabled).toBe(false);

    const lift = await op.put(`${ADMIN}/walkthroughs`, { ...after, killed: false });
    expect(lift.status).toBe(200);
    expect((await resolveOne('walkthroughs', { tenantId: 'user:k-1' }))?.enabled).toBe(true);
  });

  it('beats an open beta for everyone', async () => {
    await setGlobal('forms', 'beta', { killed: true });
    expect((await resolveOne('forms', { tenantId: 'user:k-2', userId: 'u' }))?.enabled).toBe(false);
  });

  it('is refused by the disable-lock while an enabled feature depends on it', async () => {
    await setGlobal('crm', 'on');
    await setGlobal('csm', 'on'); // csm dependsOn crm
    const cur = (await (await op.get(`${ADMIN}/crm`)).json()) as Record<string, unknown>;
    const res = await op.put(`${ADMIN}/crm`, { ...cur, killed: true });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; details?: { dependents?: string[] } };
    expect(body.error).toBe('conflict');
    expect(body.details?.dependents).toContain('csm');
    expect((await getEffectiveConfig('crm'))?.killed).toBeFalsy();
  });

  it('demo provisioning reports a killed toggle as killed and writes no override', async () => {
    await setGlobal('territories', 'off', { killed: true });
    const result = await provisionDemoFeatures('user:k-3', 'operator');
    expect(result.killed).toContain('territories');
    expect(result.enabled).not.toContain('territories');
    expect((await getEffectiveConfig('territories'))?.tenantOverrides?.['user:k-3']).toBeUndefined();
  });
});

describe('§5 — the revision precondition on DELETE', () => {
  it('a revert carrying a stale revision is 409 and the override stays', async () => {
    await setGlobal('docs', 'on');
    const loaded = (await (await op.get(`${ADMIN}/docs`)).json()) as { revision: string };
    expect(typeof loaded.revision).toBe('string');
    await setGlobal('docs', 'beta'); // someone else changes it
    const res = await op.del(`${ADMIN}/docs?revision=${loaded.revision}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe('revision_conflict');
    expect((await getEffectiveConfig('docs'))?.status).toBe('beta');
    const fresh = (await (await op.get(`${ADMIN}/docs`)).json()) as { revision: string };
    expect((await op.del(`${ADMIN}/docs?revision=${fresh.revision}`)).status).toBe(200);
  });
});

describe('§4 + hygiene — the admin surface', () => {
  it('the history route is superadmin-only and returns the audited change', async () => {
    const cur = (await (await op.get(`${ADMIN}/notebooks`)).json()) as Record<string, unknown>;
    expect((await op.put(`${ADMIN}/notebooks`, { ...cur, status: 'beta' })).status).toBe(200);
    const hist = await op.get(`${ADMIN}/notebooks/history`);
    expect(hist.status).toBe(200);
    const { changes } = (await hist.json()) as { changes: Array<{ action: string; payload: { after: { status: string } } }> };
    expect(changes[0]?.action).toBe('feature-toggle.saved');
    expect(changes[0]?.payload.after.status).toBe('beta');

    const member = client();
    await member.login('oidc:adr0819c-member', 'user:adr0819c-member');
    const refused = await member.get(`${ADMIN}/notebooks/history`);
    expect(refused.status).toBe(403);
    const rb = (await refused.json()) as { error?: string; message?: string };
    expect(rb.error).toBe('forbidden');
    expect(rb.message).toContain('Feature-toggle administration requires a superadmin principal');
  });

  it('a PUT for an undeclared toggle id is 404', async () => {
    const res = await op.put(`${ADMIN}/no-such-feature-0819`, { status: 'on' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe('not_found');
    expect(await getStoredConfig('no-such-feature-0819'), 'an orphan row was written').toBeNull();
  });
});

describe('§1 opt-outs — a lapsed plan never loosens a restriction', () => {
  it('territory scoping stays ENFORCED for a tenant whose plan excludes territories', async () => {
    await setGlobal('territories', 'on');
    const tenantId = 'ws:adr0819c-lapsed';
    // The premise: the plan really removes territories for this tenant.
    expect((await resolveOne('territories', { tenantId }))?.blockedBy).toBe('plan');
    const org = await createOrg({ tenantId, createdBy: 'u-lapsed', name: 'Lapsed org' });
    // A reader with no membership: an ENFORCING scope shows them nothing; a
    // paywall-resolved "off" would be allow-all (the row comes back).
    const rows = [{ id: 'deal-1' }, { id: 'deal-2' }];
    const visible = await filterVisibleCrmRecords({
      tenantId, orgId: org.orgId, target: 'deal', callerSubject: 'oidc:adr0819c-stranger', rows, idOf: (r) => r.id,
    });
    expect(visible).toEqual([]);
    // Control: a system read (no caller) is unscoped, so the rows exist to hide.
    expect(await filterVisibleCrmRecords({ tenantId, orgId: org.orgId, target: 'deal', callerSubject: undefined, rows, idOf: (r) => r.id })).toEqual(rows);
  });
});

describe('§1 opt-outs — a lapsed plan never darkens a PUBLIC lane (ADR 0419 shopper exemption)', () => {
  it('the public docs nav still serves for a tenant whose plan excludes docs', async () => {
    await setGlobal('docs', 'on');
    const org = await createOrg({ tenantId: 'user:adr0819c-docs', createdBy: 'u-docs', name: 'Docs org' });
    // The tenant's own authenticated lanes are paywalled (the plan excludes docs)...
    expect((await resolveOne('docs', { tenantId: 'user:adr0819c-docs' }))?.blockedBy).toBe('plan');
    // ...but a visitor reading the public docs is not the operator's customer.
    const res = await fetch(`${BASE}/host/openwop-app/public/${org.orgId}/docs`);
    // A refused lane answers 404 `not_found` (docsService `listPublishedDocs`);
    // served, the org has no published docs yet, so the nav is empty.
    expect(res.status).toBe(200);
    expect(((await res.json()) as { docs: unknown }).docs).toEqual([]);
  });
});

describe('TGWF-4 — the node lane resolves the acting user', () => {
  it('a user-listed closed-beta member is served through ctx.features', async () => {
    await setGlobal('strategy', 'beta', { betaCohort: ['oidc:beta-person'] });
    const codeOf = async (actingUserId: string): Promise<string | null> => {
      const methods = Object.values(buildFeatureSurfaces({ tenantId: OPERATOR_TENANT, actingUserId }).strategy ?? {});
      expect(methods.length).toBeGreaterThan(0);
      // A served call may still fail on its own arguments; only the toggle
      // refusal's code is what this case measures.
      return methods[0]!({}).then(() => null, (err: { code?: string }) => err.code ?? null);
    };
    expect(await codeOf('oidc:beta-person')).not.toBe('host_capability_disabled');
    // Control: someone outside the cohort IS refused on the same lane.
    expect(await codeOf('oidc:not-in-cohort')).toBe('host_capability_disabled');
  });
});
