/**
 * ADR 0820 §7 — every paid bundle's data-bearing feature can be EXPORTED after a
 * plan lapse, through the same read-only door as CRM
 * (`GET /host/openwop-app/export/features/:featureId`), while its write routes
 * keep refusing.
 *
 * Boots `createApp` with a narrowed plan (`free: []`), so a workspace with no
 * bundle grant is refused every sellable feature by the PLAN. Three workspaces:
 *  - LAPSED: no grant, rows seeded straight into its stores (written "while it
 *    had the feature"); exports them as `plan-lapsed`, writes 403;
 *  - OTHER: every bundle granted, its own rows seeded — never appears in LAPSED's
 *    export, and its writes are NOT refused (the positive control: the lapsed
 *    403s are the plan, not a broken route);
 *  - OFF: every bundle granted but each feature toggled OFF for it — 403
 *    `feature_disabled` (a kill switch is not a lapse).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { bundleFeatureIds, knownBundleIds } from '../src/host/featureBundles.js';
import { __seedBundleGrant } from '../src/features/billing/billingService.js';
import { exportableFeatureIds } from '../src/host/featureDataExport.js';
import { createBrief as createCampaignBrief } from '../src/features/campaign-brief/briefService.js';
import { createBrief as createCreativeBrief } from '../src/features/creative-briefs/creativeBriefsService.js';
import { createFunnel } from '../src/features/funnels/funnelsService.js';
import { upsertMarketingEvent } from '../src/features/webinars/entities/marketingEvent.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import { createPromotion } from '../src/features/promotions/promotionsService.js';
import { createModel } from '../src/features/territories/entities/territories.js';
import { createStrategy } from '../src/features/strategy/strategyService.js';
import { createList } from '../src/features/priority-matrix/priorityMatrixService.js';

const EXPORT = '/host/openwop-app/export/features';
const who = (role: string): string => `oidc:all-export-${role}`;

interface Case {
  featureId: string;
  /** Seed one row named `marker` into (tenantId, orgId); absent ⇒ the gate legs only. */
  seed?: (tenantId: string, orgId: string, marker: string) => Promise<unknown>;
  /** A write route of the feature (`:orgId` substituted). Absent ⇒ no plain write route. */
  write?: string;
}
const CASES: Case[] = [
  { featureId: 'campaign-brief', write: '/host/openwop-app/campaign-brief/briefs',
    seed: (t, o, m) => createCampaignBrief(t, o, 'test', { name: m, objective: 'o', productName: 'p', personaIds: ['x'], messaging: { primaryValueProp: 'v' }, channels: [{ type: 'ad_variants', enabled: true, config: {} }] } as never) },
  { featureId: 'creative-briefs', write: '/host/openwop-app/creative-briefs/orgs/:orgId/briefs',
    seed: (t, o, m) => createCreativeBrief(t, o, 'tester', { title: m, assetType: 'image', sceneDescription: 'Scene.' }) },
  { featureId: 'funnels', write: '/host/openwop-app/funnels/orgs/:orgId/funnels',
    seed: (t, o, m) => createFunnel({ tenantId: t, orgId: o, createdBy: 'u', name: m }) },
  { featureId: 'webinars', write: '/host/openwop-app/webinars/orgs/:orgId/events',
    seed: (t, o, m) => upsertMarketingEvent({ tenantId: t, orgId: o, provider: 'zoom', providerEventId: m } as never) },
  { featureId: 'commerce', write: '/host/openwop-app/commerce/orgs/:orgId/products',
    seed: (t, o, m) => createProduct({ tenantId: t, orgId: o, createdBy: 'user:p', type: 'digital', name: m, price: 19 }) },
  { featureId: 'promotions', write: '/host/openwop-app/promotions/orgs/:orgId/promotions',
    seed: (t, o, m) => createPromotion({ tenantId: t, orgId: o, createdBy: 'u', name: m, type: 'tiered', reward: { kind: 'percentage', value: 10 }, minQuantity: 3 }) },
  { featureId: 'territories', write: '/host/openwop-app/territories/orgs/:orgId/models',
    seed: (t, o, m) => createModel(t, o, { name: m }, 'user:x') },
  { featureId: 'sales-commissions', write: '/host/openwop-app/commissions/orgs/:orgId/plans' },
  { featureId: 'dealers', write: '/host/openwop-app/dealers/orgs/:orgId/dealers' },
  { featureId: 'strategy', write: '/host/openwop-app/strategy',
    seed: (t, o, m) => createStrategy(t, o, 'u-1', { title: m, scope: 'org' }) },
  { featureId: 'priority-matrix', write: '/host/openwop-app/priority-matrix/lists',
    seed: (t, o, m) => createList(t, o, 'own', { name: m }) },
  { featureId: 'app-builder' },
  { featureId: 'campaign-orchestration' },
  { featureId: 'advisory-board', write: '/host/openwop-app/advisors/boards' },
  { featureId: 'twin-recall', write: '/host/openwop-app/profiles/me/twin-grants' },
  { featureId: 'job-search', write: '/host/openwop-app/job-search/orgs/:orgId/applications' },
];

let server: http.Server;
let BASE = '';
let LAPSED = '';
let OTHER = '';
let OFF = '';

async function login(subject: string, tenantId: string): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace: true }),
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
  for (const role of ['admin', 'editor'] as const) {
    await createMember({ orgId: id, tenantId: id, displayName: role, subject: userIdFor(id, who(`${tag}-${role}`)), roles: [role] });
  }
  return id;
}
const marker = (tag: string, featureId: string): string => `${tag}-${featureId}-zzmarker`;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: [], pro: '*' });
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const billing = getToggleDefault('billing');
  if (billing) await saveConfig({ ...billing, status: 'on' }, 'test');

  LAPSED = await workspace('Lapsed workspace', 'l');
  OTHER = await workspace('Entitled workspace', 'e');
  OFF = await workspace('Features switched off', 'o');
  const now = new Date().toISOString();
  for (const b of knownBundleIds()) {
    await __seedBundleGrant(OTHER, b, { status: 'active', stripeStatus: 'active', updatedAt: now });
    await __seedBundleGrant(OFF, b, { status: 'active', stripeStatus: 'active', updatedAt: now });
  }
  for (const c of CASES) {
    const def = getToggleDefault(c.featureId);
    if (def) await saveConfig({ ...def, status: 'on', tenantOverrides: { [OFF]: { status: 'off' } } }, 'test');
    if (c.seed) {
      await c.seed(LAPSED, LAPSED, marker('lapsed', c.featureId));
      await c.seed(OTHER, OTHER, marker('other', c.featureId));
    }
  }
});

afterAll(async () => {
  for (const k of ['OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_BILLING_PLAN_FEATURES']) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0820 §7 — fixture sanity', () => {
  it('every case is a sellable bundle feature with a registered exporter', () => {
    const sold = new Set(knownBundleIds().flatMap((b) => bundleFeatureIds(b)));
    for (const c of CASES) {
      expect(sold.has(c.featureId), `${c.featureId} is in a bundle`).toBe(true);
      expect(exportableFeatureIds(), `${c.featureId} registers an exporter`).toContain(c.featureId);
    }
  });
});

describe.each(CASES)('ADR 0820 §7 — $featureId export after a plan lapse', (c) => {
  it('the lapsed workspace\'s admin exports it (200, plan-lapsed, read-only) — its own rows only', async () => {
    const res = await get(`${EXPORT}/${c.featureId}`, await login(who('l-admin'), LAPSED));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { featureId: string; readOnly: boolean; access: string; sections: Record<string, unknown[]>; page: { nextOffset: number | null } };
    expect(body).toMatchObject({ featureId: c.featureId, readOnly: true, access: 'plan-lapsed' });
    expect(body.page.nextOffset).toBeNull();
    const text = JSON.stringify(body.sections);
    if (c.seed) expect(text, 'the lapsed workspace\'s own row').toContain(marker('lapsed', c.featureId));
    expect(text, 'never another workspace\'s row').not.toContain(marker('other', c.featureId));
  });

  it('a toggle switched OFF is refused (403 feature_disabled)', async () => {
    const res = await get(`${EXPORT}/${c.featureId}`, await login(who('o-admin'), OFF));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('feature_disabled');
  });

  it('an editor is refused (403)', async () => {
    expect((await get(`${EXPORT}/${c.featureId}`, await login(who('l-editor'), LAPSED))).status).toBe(403);
  });

  it('POSITIVE: the entitled workspace exports as entitled, with its own row', async () => {
    const res = await get(`${EXPORT}/${c.featureId}`, await login(who('e-admin'), OTHER));
    expect(res.status).toBe(200);
    const body = await res.json() as { access: string; sections: unknown };
    expect(body.access).toBe('entitled');
    if (c.seed) expect(JSON.stringify(body.sections)).toContain(marker('other', c.featureId));
  });

  it.runIf(Boolean(c.write))('the feature\'s write route still refuses the lapsed admin BY THE PLAN; the entitled admin is not plan-refused', async () => {
    // The lapsed 403 must be the PLAN refusal (naming this feature), not a scope
    // refusal that would pass for the wrong reason. The control: the same route
    // for the entitled admin is never the plan refusal (it may still be a 400/
    // scope answer for a body this test does not bother to make valid).
    const PLAN_REFUSAL = 'does not include this feature';
    const lapsed = await post(c.write!.replace(':orgId', LAPSED), await login(who('l-admin'), LAPSED), { name: 'should not land' });
    const text = await lapsed.text();
    expect(lapsed.status, text).toBe(403);
    expect(text).toContain(PLAN_REFUSAL);
    expect(text).toContain(`"feature":"${c.featureId}"`);
    const entitled = await post(c.write!.replace(':orgId', OTHER), await login(who('e-admin'), OTHER), { name: 'x' });
    expect(await entitled.text(), `entitled write ${c.featureId}`).not.toContain(PLAN_REFUSAL);
  });
});

describe('ADR 0820 §7 — discovery and paging', () => {
  it('GET …/export/features lists what THIS workspace can export, with labels', async () => {
    const lapsed = await (await get(EXPORT, await login(who('l-admin'), LAPSED))).json() as { exportable: Array<{ featureId: string; label: string; access: string }> };
    const funnels = lapsed.exportable.find((e) => e.featureId === 'funnels');
    expect(funnels).toMatchObject({ access: 'plan-lapsed' });
    expect(typeof funnels?.label).toBe('string');
    // OFF has every case toggled off: none of them is listed as exportable there.
    const off = await (await get(EXPORT, await login(who('o-admin'), OFF))).json() as { exportable: Array<{ featureId: string }> };
    for (const c of CASES) expect(off.exportable.map((e) => e.featureId)).not.toContain(c.featureId);
  });

  it('sections are paged: limit=1 returns one row and a nextOffset, the next page the rest', async () => {
    await createFunnel({ tenantId: LAPSED, orgId: LAPSED, createdBy: 'u', name: 'second funnel' });
    const cookie = await login(who('l-admin'), LAPSED);
    const p1 = await (await get(`${EXPORT}/funnels?limit=1`, cookie)).json() as { sections: { funnels: unknown[] }; page: { nextOffset: number | null; totals: Record<string, number> } };
    expect(p1.sections.funnels).toHaveLength(1);
    expect(p1.page.totals.funnels).toBe(2);
    expect(p1.page.nextOffset).toBe(1);
    const p2 = await (await get(`${EXPORT}/funnels?limit=1&offset=1`, cookie)).json() as { sections: { funnels: unknown[] }; page: { nextOffset: number | null } };
    expect(p2.sections.funnels).toHaveLength(1);
    expect(p2.page.nextOffset).toBeNull();
  });
});
