/**
 * ADR 0948 P0 — funnels link to the canonical campaign, checkout offers are
 * server-validated, and a client org of an agency workspace settles only through
 * its OWN Connect seller (David, 2026-10-19, #5038).
 *
 *  - D1: an offer sits only on a money step, bumps only on checkout, the one-click
 *    product only on upsell/downsell; every offered product is an ACTIVE product
 *    of THIS org (another org's product is the same 404 as a missing one); a
 *    `campaignId` must be a campaign of THIS org (404 otherwise); an editor that
 *    re-saves steps without `offer` keeps the stored offer.
 *  - D2: a public checkout naming a funnel step accepts only that step's offered
 *    bumps; a draft funnel, another org's funnel or a non-checkout step is one
 *    uniform 400; without a funnel ref the storefront is unchanged.
 *  - D8: a non-root org of a `ws:` workspace resolves to `demo/connect_required`
 *    even while the workspace's own seller is READY (never the agency's
 *    account); its money steps cannot publish, nor be added to a live funnel;
 *    the workspace root still publishes; a host with no Stripe key does not block.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { removeSecret, setSecret } from '../src/byok/secretResolver.js';
import { createOrg, createWorkspace, isNonRootWorkspaceOrg } from '../src/host/accessControlService.js';
import { createProduct, getOrder, updateProduct } from '../src/features/commerce/commerceService.js';
import { createPage } from '../src/features/cms/cmsService.js';
import { createFunnel, getFunnel, publishFunnel, updateFunnel, type FunnelStep } from '../src/features/funnels/funnelsService.js';
import { resolveStorefrontSettlement } from '../src/features/commerce-connect/storefrontSettlement.js';
import { sellers, accountIndex } from '../src/features/commerce-connect/stores.js';
import { createBrief, setKernel, updateBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { publishedFunnel } from './helpers/publishedFunnel.js';

let BASE = ''; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['commerce', 'funnels', 'commerce-connect']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function product(tenantId: string, orgId: string, name: string, active = true): Promise<string> {
  const p = await createProduct({ tenantId, orgId, createdBy: 'test', type: 'digital', name, price: 10, currency: 'USD' });
  if (!active) await updateProduct(tenantId, orgId, p.productId, { active: false });
  return p.productId;
}
async function page(tenantId: string, orgId: string): Promise<string> {
  return (await createPage({ tenantId, orgId, title: `Page ${n++}`, createdBy: 'test' })).pageId;
}
async function errorOf(p: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try { await p; return { status: 0 }; } catch (e) {
    const err = e as { httpStatus?: number; details?: { code?: string } };
    return { status: err.httpStatus ?? -1, code: err.details?.code };
  }
}
const KERNEL = { headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see', tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-10-20T00:00:00Z' };
async function campaignIn(tenantId: string, orgId: string): Promise<string> {
  const brief = await createBrief(tenantId, orgId, 'test', { name: `C${n++}`, objective: 'o', productName: 'p', personaIds: ['x'], messaging: { primaryValueProp: 'v' }, channels: [{ type: 'ad_variants', enabled: true, config: {} }] });
  await setKernel(tenantId, brief.id, KERNEL);
  await updateBrief(tenantId, brief.id, { status: 'confirmed' }, 'test');
  return (await finalizeFromBrief(tenantId, { ...brief, kernel: KERNEL, status: 'confirmed' as const }, 'test')).id;
}

describe('ADR 0948 D1 — offers and the campaign link are validated at write', () => {
  const T = 'user:adr0948-d1';
  it('an offer belongs only on a money step, with bumps on checkout and the one-click product on upsell/downsell', async () => {
    const orgId = 'org-d1-a';
    const p1 = await product(T, orgId, 'Main');
    const pg = await page(T, orgId);
    expect((await errorOf(createFunnel({ tenantId: T, orgId, createdBy: 't', name: 'x', steps: [{ kind: 'landing', pageId: pg, offer: { productIds: [p1] } }] }))).status).toBe(400);
    expect((await errorOf(createFunnel({ tenantId: T, orgId, createdBy: 't', name: 'x', steps: [{ kind: 'upsell', pageId: pg, offer: { productIds: [p1], bumpProductIds: [p1] } }] }))).status).toBe(400);
    expect((await errorOf(createFunnel({ tenantId: T, orgId, createdBy: 't', name: 'x', steps: [{ kind: 'checkout', pageId: pg, offer: { productIds: [p1], oneClickProductId: p1 } }] }))).status).toBe(400);
    expect((await errorOf(createFunnel({ tenantId: T, orgId, createdBy: 't', name: 'x', steps: [{ kind: 'checkout', pageId: pg, offer: { productIds: [] } }] }))).status).toBe(400);
    const six = await Promise.all(Array.from({ length: 6 }, (_, i) => product(T, orgId, `B${i}`)));
    expect((await errorOf(createFunnel({ tenantId: T, orgId, createdBy: 't', name: 'x', steps: [{ kind: 'checkout', pageId: pg, offer: { productIds: [p1], bumpProductIds: six } }] }))).status).toBe(400);
    const ok = await createFunnel({ tenantId: T, orgId, createdBy: 't', name: 'ok', steps: [{ kind: 'checkout', pageId: pg, offer: { productIds: [p1], bumpProductIds: [six[0]!] } }] });
    expect(ok.steps[0]!.offer).toEqual({ productIds: [p1], bumpProductIds: [six[0]] });
  });

  it("another org's product, and an inactive product, are the same 404", async () => {
    const orgId = 'org-d1-b';
    const foreign = await product(T, 'org-d1-other', 'Foreign');
    const inactive = await product(T, orgId, 'Old', false);
    const pg = await page(T, orgId);
    for (const pid of [foreign, inactive, 'no-such-product']) {
      expect(await errorOf(createFunnel({ tenantId: T, orgId, createdBy: 't', name: 'x', steps: [{ kind: 'checkout', pageId: pg, offer: { productIds: [pid] } }] }))).toEqual({ status: 404, code: undefined });
    }
  });

  it("campaignId must be a campaign of THIS org; null clears it", async () => {
    const orgId = 'org-d1-c';
    const mine = await campaignIn(T, orgId);
    const theirs = await campaignIn(T, 'org-d1-d');
    expect((await errorOf(createFunnel({ tenantId: T, orgId, createdBy: 't', name: 'x', campaignId: theirs }))).status).toBe(404);
    expect((await errorOf(createFunnel({ tenantId: T, orgId, createdBy: 't', name: 'x', campaignId: 'no-such-campaign' }))).status).toBe(404);
    const f = await createFunnel({ tenantId: T, orgId, createdBy: 't', name: 'linked', campaignId: mine });
    expect(f.campaignId).toBe(mine);
    expect((await errorOf(updateFunnel(T, orgId, f.funnelId, { campaignId: theirs }))).status).toBe(404);
    const cleared = await updateFunnel(T, orgId, f.funnelId, { campaignId: null });
    expect(cleared?.campaignId).toBeUndefined();
  });

  it('re-saving steps without the offer key keeps the stored offer; offer:null clears it', async () => {
    const orgId = 'org-d1-e';
    const p1 = await product(T, orgId, 'Main');
    const pg = await page(T, orgId);
    const f = await createFunnel({ tenantId: T, orgId, createdBy: 't', name: 'carry', steps: [{ kind: 'checkout', pageId: pg, offer: { productIds: [p1] } }] });
    const stepId = f.steps[0]!.stepId;
    const kept = await updateFunnel(T, orgId, f.funnelId, { steps: [{ stepId, kind: 'checkout', pageId: pg, name: 'Pay' }] });
    expect(kept?.steps[0]!.offer).toEqual({ productIds: [p1] });
    const cleared = await updateFunnel(T, orgId, f.funnelId, { steps: [{ stepId, kind: 'checkout', pageId: pg, offer: null }] });
    expect(cleared?.steps[0]!.offer).toBeUndefined();
  });
});

interface PostBody { orderId?: string; error?: string; details?: { code?: string } }
async function postJson(path: string, body: unknown): Promise<{ status: number; body: PostBody }> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  const parsed: PostBody = text ? JSON.parse(text) : {};
  return { status: res.status, body: parsed };
}

describe('ADR 0948 D2 — the public checkout sells what the funnel step offers', () => {
  it('an offered bump passes; an unoffered one is 400 bump_not_offered; a draft, foreign or non-checkout step is the same 400', async () => {
    const T = 'user:adr0948-d2';
    const orgId = (await createOrg({ tenantId: T, createdBy: 'seed', name: 'Store' })).orgId; // the public store resolves a REAL org
    const main = await product(T, orgId, 'Course');
    const offered = await product(T, orgId, 'Workbook');
    const other = await product(T, orgId, 'Sticker');
    const fn = await publishedFunnel(T, orgId, [
      { kind: 'checkout', offer: { productIds: [main], bumpProductIds: [offered] } },
      { kind: 'thankyou' },
    ]);
    const checkout = `/host/openwop-app/public-store/${encodeURIComponent(orgId)}/checkout`;
    const base = { email: `g${n++}@x.test`, lines: [{ productId: main, quantity: 1 }] };
    const good = await postJson(checkout, { ...base, bumps: [{ productId: offered }], funnel: { funnelId: fn.funnelId, stepId: fn.stepIds[0] } });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
    expect((await getOrder(T, orgId, good.body.orderId!))?.items.some((i) => i.productId === offered && i.origin === 'bump')).toBe(true);

    const bad = await postJson(checkout, { ...base, bumps: [{ productId: other }], funnel: { funnelId: fn.funnelId, stepId: fn.stepIds[0] } });
    expect([bad.status, bad.body.details?.code]).toEqual([400, 'bump_not_offered']);

    const draft = await createFunnel({ tenantId: T, orgId, createdBy: 't', name: 'draft', steps: [{ kind: 'checkout', pageId: await page(T, orgId), offer: { productIds: [main], bumpProductIds: [other] } }] });
    for (const ref of [
      { funnelId: draft.funnelId, stepId: draft.steps[0]!.stepId },      // not published
      { funnelId: fn.funnelId, stepId: fn.stepIds[1] },                // not a checkout
      { funnelId: fn.funnelId, stepId: 'no-such-step' },
      { funnelId: 'no-such-funnel', stepId: fn.stepIds[0] },
    ]) {
      const r = await postJson(checkout, { ...base, bumps: [{ productId: other }], funnel: ref });
      expect([r.status, r.body.details?.code], JSON.stringify(ref)).toEqual([400, 'funnel_step_not_found']);
    }
    // Without a funnel ref the plain storefront behaves as before.
    const plain = await postJson(checkout, { ...base, bumps: [{ productId: other }] });
    expect(plain.status).toBe(201);
  });

  it("another org's published funnel is the same 400 on this org's store", async () => {
    const T = 'user:adr0948-d2b';
    const storeOrg = (await createOrg({ tenantId: T, createdBy: 'seed', name: 'Store B' })).orgId;
    const main = await product(T, storeOrg, 'Course');
    const foreignOrg = (await createOrg({ tenantId: T, createdBy: 'seed', name: 'Foreign' })).orgId;
    const fp = await product(T, foreignOrg, 'X');
    const foreign = await publishedFunnel(T, foreignOrg, [{ kind: 'checkout', offer: { productIds: [fp] } }]);
    const r = await postJson(`/host/openwop-app/public-store/${encodeURIComponent(storeOrg)}/checkout`, {
      email: `g${n++}@x.test`, lines: [{ productId: main, quantity: 1 }], funnel: { funnelId: foreign.funnelId, stepId: foreign.stepIds[0] },
    });
    expect([r.status, r.body.details?.code]).toEqual([400, 'funnel_step_not_found']);
  });
});

describe('ADR 0948 D8 — a client org settles only through its own seller', () => {
  it('a client org is never the agency; its money steps cannot go live; the root can; no-key hosts do not block', async () => {
    const ws = await createWorkspace({ name: `Agency ${n++}`, ownerSubject: `oidc:adr0948-${n}` });
    const T = ws.tenantId;
    const client = (await createOrg({ tenantId: T, createdBy: 'seed', name: 'Client A' })).orgId;
    expect(isNonRootWorkspaceOrg(T, client)).toBe(true);
    expect(isNonRootWorkspaceOrg(T, T)).toBe(false);

    // No Stripe key on the host: nobody can take money, so a client checkout may publish.
    await removeSecret('billing:stripe-key');
    const pc = await product(T, client, 'Client course');
    const noKey = await publishedFunnel(T, client, [{ kind: 'checkout', offer: { productIds: [pc] } }]);
    expect((await getFunnel(T, client, noKey.funnelId))?.status).toBe('published');

    // Live host + the AGENCY (workspace) seller is fully onboarded.
    await setSecret('billing:stripe-key', 'sk_test_mock');
    const acct = `acct_agency_${n++}`; const now = new Date().toISOString();
    await sellers.put({ tenantId: T, stripeAccountId: acct, onboardingState: 'enabled', chargesEnabled: true, payoutsEnabled: true, region: 'US', capabilities: ['card_payments', 'transfers'], mode: 'live', createdAt: now, updatedAt: now });
    await accountIndex.put({ stripeAccountId: acct, tenantId: T });

    expect(await resolveStorefrontSettlement(T, T)).toMatchObject({ kind: 'connect', destinationAccountId: acct });
    // The client org NEVER settles on the agency's account.
    expect(await resolveStorefrontSettlement(T, client)).toEqual({ kind: 'demo', reason: 'client_seller_required' });

    // Publish is refused for the client's money step …
    const pg = await page(T, client);
    const f = await createFunnel({ tenantId: T, orgId: client, createdBy: 't', name: 'Client checkout', steps: [{ kind: 'checkout', pageId: pg, offer: { productIds: [pc] } }] });
    expect(await errorOf(publishFunnel(T, client, f.funnelId))).toEqual({ status: 409, code: 'client_settlement_unconfirmed' });

    // … a non-money funnel still publishes, and a checkout cannot be ADDED to it while live.
    const lp = await page(T, client);
    const g = await createFunnel({ tenantId: T, orgId: client, createdBy: 't', name: 'Lead magnet', steps: [{ kind: 'optin', pageId: lp }] });
    expect((await publishFunnel(T, client, g.funnelId))?.status).toBe('published');
    const live: FunnelStep[] = (await getFunnel(T, client, g.funnelId))!.steps;
    expect(await errorOf(updateFunnel(T, client, g.funnelId, { steps: [...live, { kind: 'checkout', pageId: pg, offer: { productIds: [pc] } }] }))).toEqual({ status: 409, code: 'client_settlement_unconfirmed' });

    // The workspace root (the agency's own store) publishes on its own seller.
    const pr = await product(T, T, 'Agency course');
    const root = await createFunnel({ tenantId: T, orgId: T, createdBy: 't', name: 'Agency checkout', steps: [{ kind: 'checkout', pageId: await page(T, T), offer: { productIds: [pr] } }] });
    expect((await publishFunnel(T, T, root.funnelId))?.status).toBe('published');
  });
});
