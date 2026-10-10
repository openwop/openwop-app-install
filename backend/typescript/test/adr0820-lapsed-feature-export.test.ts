/**
 * ADR 0820 §7 — "downgrade never deletes data; a read-only export goes through
 * `portability`". `GET /host/openwop-app/export/features/:featureId` hands a
 * workspace its data back after the plan stopped including the feature, while
 * every normal read and write lane of that feature keeps refusing.
 *
 * Boots `createApp` so billing registers the real tenant entitlement check and
 * CRM registers its real exporter. The plan is narrowed (`free: []`), so a
 * workspace with no CRM bundle grant is refused CRM by the PLAN — the lapse.
 * Authority legs use the ADR 0554 §P3 harness (shared workspace, membership
 * created BEFORE login) so the personal short-circuit cannot make a 403
 * unfalsifiable.
 *
 * Positive controls: the lapsed workspace's OWNER and ADMIN are served; an
 * entitled workspace is served AND can still write (so the lapsed 403s are the
 * plan, not a broken route).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { bundleFeatureIds, knownBundleIds } from '../src/host/featureBundles.js';
import { __seedBundleGrant } from '../src/features/billing/billingService.js';

const EXPORT = '/host/openwop-app/export/features';
const CRM_BUNDLE = knownBundleIds().find((b) => bundleFeatureIds(b).includes('crm')) ?? '';
const who = (role: string): string => `oidc:lapse-export-${role}`;
let server: http.Server;
let BASE = '';
let LAPSED = '';
let ENTITLED = '';
let TOGGLED_OFF = '';

async function login(subject: string, tenantId: string, sharedWorkspace = true): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace }),
  });
  expect(res.status, 'test seam must mint a session').toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}
const get = (path: string, cookie: string) => fetch(`${BASE}${path}`, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function workspace(name: string, tag: string): Promise<string> {
  const ws = await createWorkspace({ name, ownerSubject: who(`${tag}-owner`) });
  const id = ws.orgId ?? ws.tenantId;
  for (const role of ['admin', 'editor', 'viewer'] as const) {
    await createMember({ orgId: id, tenantId: id, displayName: role, subject: userIdFor(id, who(`${tag}-${role}`)), roles: [role] });
  }
  return id;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // A narrowed host: the free plan holds no sellable feature.
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: [], pro: '*' });
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const billing = getToggleDefault('billing');
  if (billing) await saveConfig({ ...billing, status: 'on' }, 'test');

  LAPSED = await workspace('Lapsed CRM workspace', 'l');
  ENTITLED = await workspace('Entitled CRM workspace', 'e');
  TOGGLED_OFF = await workspace('CRM switched off', 'o');
  await __seedBundleGrant(ENTITLED, CRM_BUNDLE, { status: 'active', stripeStatus: 'active', updatedAt: new Date().toISOString() });
  await __seedBundleGrant(TOGGLED_OFF, CRM_BUNDLE, { status: 'active', stripeStatus: 'active', updatedAt: new Date().toISOString() });
  const crm = getToggleDefault('crm');
  if (crm) await saveConfig({ ...crm, status: 'on', tenantOverrides: { [TOGGLED_OFF]: { status: 'off' } } }, 'test');

  // Data written while the workspace still had CRM.
  await createContact({ tenantId: LAPSED, name: 'Ada Lovelace', email: 'ada@lapsed.test' });
  await createContact({ tenantId: ENTITLED, name: 'Grace Hopper', email: 'grace@entitled.test' });
});

afterAll(async () => {
  for (const k of ['OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_BILLING_PLAN_FEATURES']) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
});

interface ExportBody { featureId: string; readOnly: boolean; access: string; sections: { contacts: Array<{ name: string; email?: string }> } }

describe('ADR 0820 §7 — a lapsed workspace can still EXPORT its CRM data', () => {
  it('fixture sanity: crm is sold in a bundle', () => {
    expect(CRM_BUNDLE).not.toBe('');
  });

  it('the lapsed workspace\'s ADMIN exports its contacts (200, access plan-lapsed, read-only)', async () => {
    const res = await get(`${EXPORT}/crm`, await login(who('l-admin'), LAPSED));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as ExportBody;
    expect(body).toMatchObject({ featureId: 'crm', readOnly: true, access: 'plan-lapsed' });
    expect(body.sections.contacts.map((c) => c.email)).toEqual(['ada@lapsed.test']);
    expect(res.headers.get('content-disposition')).toContain('crm-export-');
  });

  it('the lapsed workspace\'s OWNER is served too', async () => {
    expect((await get(`${EXPORT}/crm`, await login(who('l-owner'), LAPSED))).status).toBe(200);
  });

  it('…while the CRM write route still refuses the same admin (403), and nothing was written', async () => {
    const cookie = await login(who('l-admin'), LAPSED);
    const write = await post('/host/openwop-app/crm/contacts', cookie, { name: 'Should Not Land' });
    expect(write.status).toBe(403);
    const after = await (await get(`${EXPORT}/crm`, cookie)).json() as ExportBody;
    expect(after.sections.contacts.map((c) => c.name)).toEqual(['Ada Lovelace']);
  });

  it('…and the normal CRM read route still refuses (403): the export is not a back door to the feature', async () => {
    expect((await get('/host/openwop-app/crm/contacts', await login(who('l-admin'), LAPSED))).status).toBe(403);
  });

  it('POSITIVE: an entitled workspace exports (access entitled) AND can still write — the lapsed 403s are the plan', async () => {
    const cookie = await login(who('e-admin'), ENTITLED);
    const res = await get(`${EXPORT}/crm`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json() as ExportBody;
    expect(body.access).toBe('entitled');
    expect(body.sections.contacts.map((c) => c.email)).toEqual(['grace@entitled.test']);
    expect((await post('/host/openwop-app/crm/contacts', cookie, { name: 'Lands Fine' })).status).toBe(201);
  });

  it('a workspace never sees another workspace\'s rows', async () => {
    const body = await (await get(`${EXPORT}/crm`, await login(who('l-admin'), LAPSED))).json() as ExportBody;
    expect(JSON.stringify(body)).not.toContain('grace@entitled.test');
  });
});

describe('ADR 0820 §7 — export authz: workspace admins and owners only', () => {
  it('an EDITOR is refused 403 naming host:billing:manage', async () => {
    const res = await get(`${EXPORT}/crm`, await login(who('l-editor'), LAPSED));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('host:billing:manage');
  });

  it('a VIEWER is refused 403', async () => {
    expect((await get(`${EXPORT}/crm`, await login(who('l-viewer'), LAPSED))).status).toBe(403);
  });

  it('a non-member never exports the workspace\'s rows', async () => {
    // Under `sharedWorkspace: true` a NON-member is bounced to their own personal
    // tenant by the ADR 0015 re-check (`authTestSeam.ts`), so the outcome is a
    // refusal or THEIR OWN empty export — never this workspace's data.
    const res = await get(`${EXPORT}/crm`, await login(who('outsider'), LAPSED));
    if (res.status === 200) {
      expect(JSON.stringify(await res.json())).not.toContain('ada@lapsed.test');
    } else {
      expect(res.status).toBe(403);
    }
  });

  it('the discovery list is admin-only too, and names crm for an admin', async () => {
    expect((await get(EXPORT, await login(who('l-editor'), LAPSED))).status).toBe(403);
    const res = await get(EXPORT, await login(who('l-admin'), LAPSED));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { features: string[] }).features).toContain('crm');
  });
});

describe('ADR 0820 §7 — the export only widens the PLAN refusal', () => {
  it('a feature switched OFF by toggle is refused (403 feature_disabled): a kill switch is not a lapse', async () => {
    const res = await get(`${EXPORT}/crm`, await login(who('o-admin'), TOGGLED_OFF));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('feature_disabled');
  });

  it('a feature with no registered exporter is 404', async () => {
    expect((await get(`${EXPORT}/not-a-feature`, await login(who('l-admin'), LAPSED))).status).toBe(404);
  });

  it('the export route is GET-only: there is no write verb on it', async () => {
    const res = await post(`${EXPORT}/crm`, await login(who('l-admin'), LAPSED), { sections: {} });
    expect([404, 405]).toContain(res.status);
  });
});
