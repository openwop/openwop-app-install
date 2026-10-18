/**
 * ADR 0455 P1 — `productForChallenge`, the reverse lookup the KickTodo Detail
 * page needs to SURFACE a paid challenge's price (today it dead-ends at the
 * enroll wall). Pins: no link ⇒ null (free); a linked product ⇒ its price/org;
 * multiple tiers ⇒ the LOWEST ACTIVE price (OQ2); an INACTIVE cheaper tier never
 * wins while an active one exists. Plus the ADR 0451 P2b `referral-code` ROUTE
 * (routes.ts — GET …/challenges/:id/:version/referral-code), driven over HTTP.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { createOrder, createProduct, deleteProduct, updateProduct } from '../src/features/commerce/commerceService.js';
import {
  enrollGuardVerdict, getEntitlement, getLinkByProduct, isChallengePaid, linkChallengeProduct, productForChallenge, reprocessOrder,
} from '../src/features/kicktodo-commerce/entitlementService.js';
import {
  ensureAffiliateForSubject, resolveSubjectForAffiliateCode, __resetSubjectAffiliateBridge,
} from '../src/features/kicktodo-commerce/subjectAffiliateBridge.js';
import { KICKTODO_COMMERCE_PREFIX } from '../src/features/kicktodo-commerce/routes.js';
import { __resetAffiliates, affiliateByCode } from '../src/features/commerce/affiliate.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';

const T = 'tenant-pfc';
const ORG = 'org-pfc';

async function publishedChallenge(tenantId: string = T): Promise<string> {
  const draft = await createDraft({
    tenantId, title: 'Paid', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(tenantId, draft.id, 1);
  return draft.id;
}

const freshStore = async (): Promise<void> => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
};

describe('productForChallenge (ADR 0455 P1)', () => {
  beforeEach(freshStore);

  it('returns null for a free (unlinked) challenge', async () => {
    // ANOTHER challenge in the same tenant IS for sale — the lookup must be
    // per-challenge, not "anything linked in the tenant".
    const sold = await publishedChallenge();
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Sold', price: 19.99 });
    await linkChallengeProduct(T, product.productId, sold, 1, 'user:pub');
    expect((await productForChallenge(T, sold, 1))?.productId).toBe(product.productId); // positive control

    const challengeId = await publishedChallenge();
    expect(await productForChallenge(T, challengeId, 1)).toBeNull();
  });

  it('returns the linked product price + org', async () => {
    const challengeId = await publishedChallenge();
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Course', price: 19 });
    await linkChallengeProduct(T, product.productId, challengeId, 1, 'user:pub');

    const info = await productForChallenge(T, challengeId, 1);
    expect(info).not.toBeNull();
    expect(info?.productId).toBe(product.productId);
    expect(info?.orgId).toBe(ORG);
    expect(info?.price).toBe(19);
    expect(info?.active).toBe(true);
  });

  it('with multiple tiers, picks the lowest active price (OQ2)', async () => {
    const challengeId = await publishedChallenge();
    const premium = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Premium', price: 49 });
    const basic = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Basic', price: 9 });
    await linkChallengeProduct(T, premium.productId, challengeId, 1, 'user:pub');
    await linkChallengeProduct(T, basic.productId, challengeId, 1, 'user:pub');

    // A CHEAPER tier that is INACTIVE must not win while an active one exists.
    const retired = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Retired', price: 4.99 });
    await linkChallengeProduct(T, retired.productId, challengeId, 1, 'user:pub');
    expect((await updateProduct(T, ORG, retired.productId, { active: false }))?.active).toBe(false);

    const info = await productForChallenge(T, challengeId, 1);
    expect(info?.price).toBe(9);
    expect(info?.productId).toBe(basic.productId);
    expect(info?.active).toBe(true);
  });

  it('when EVERY tier is inactive, returns the lowest one flagged inactive (temporarily unavailable)', async () => {
    const challengeId = await publishedChallenge();
    const a = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'A', price: 29.99 });
    const b = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'B', price: 14.99 });
    for (const p of [a, b]) {
      await linkChallengeProduct(T, p.productId, challengeId, 1, 'user:pub');
      await updateProduct(T, ORG, p.productId, { active: false });
    }
    expect(await productForChallenge(T, challengeId, 1)).toEqual({
      productId: b.productId, orgId: ORG, price: 14.99, currency: b.currency, active: false,
    });
  });
});

describe('a DELETED product (KTCOM-3)', () => {
  beforeEach(freshStore);

  // KTCOM-3 — the paywall and the price lookup must agree. Before the fix a deleted
  // product's link kept `isChallengePaid` true (so the enroll guard demanded a
  // checkout) while `productForChallenge` returned null (so there was nothing to buy).
  // Sabotage (witnessed): make `isChallengePaid` count a link without resolving its
  // product (the old `rows.some(...)` body) and the "not paywalled" expectation goes red.
  it('stops paywalling once every linked product is gone, and the link survives for in-flight money', async () => {
    const challengeId = await publishedChallenge();
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Gone', price: 19 });
    await linkChallengeProduct(T, product.productId, challengeId, 1, 'user:pub');
    // An order placed BEFORE the delete, paid after it (a slow webhook).
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'user:late-buyer', lines: [{ productId: product.productId, quantity: 1 }] });
    expect(await isChallengePaid(T, challengeId, 1)).toBe(true); // control

    expect(await deleteProduct(T, ORG, product.productId)).toBe(true);
    expect(await productForChallenge(T, challengeId, 1)).toBeNull();
    expect(await isChallengePaid(T, challengeId, 1), 'no product left to buy ⇒ not paywalled').toBe(false);
    expect(await enrollGuardVerdict({ tenantId: T, ownerSubject: 'user:someone', challenge: { id: challengeId, version: 1 } })).toEqual({ ok: true });

    // The link row is kept on purpose: the late payment still grants what it bought.
    expect(await getLinkByProduct(T, product.productId)).not.toBeNull();
    expect(await reprocessOrder(order, 'grant')).toBe(1);
    expect((await getEntitlement(T, 'user:late-buyer', challengeId, 1))?.state).toBe('active');
  });

  it('stays paywalled while ANOTHER linked product still exists', async () => {
    const challengeId = await publishedChallenge();
    const gone = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Gone', price: 9 });
    const kept = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Kept', price: 29 });
    await linkChallengeProduct(T, gone.productId, challengeId, 1, 'user:pub');
    await linkChallengeProduct(T, kept.productId, challengeId, 1, 'user:pub');
    await deleteProduct(T, ORG, gone.productId);
    expect(await isChallengePaid(T, challengeId, 1)).toBe(true);
    expect((await productForChallenge(T, challengeId, 1))?.productId).toBe(kept.productId);
  });
});

describe('referral-code resolution (ADR 0451 P2b — the composition the route performs)', () => {
  beforeEach(freshStore);

  // TWIN (service level): the route case below drives the SAME composition over
  // HTTP; kicktodo-subject-affiliate "lazily mints one stable affiliate per subject"
  // covers the mint itself. Kept as the fast, storage-only statement of the rule.
  it('productForChallenge supplies the org the inviter\'s code is minted in; a free challenge has no product', async () => {
    await __resetSubjectAffiliateBridge();
    await __resetAffiliates();
    // Free challenge ⇒ no product ⇒ productForChallenge null ⇒ the route returns { code: null }.
    const freeId = await publishedChallenge();
    expect(await productForChallenge(T, freeId, 1)).toBeNull();

    // Paid challenge ⇒ resolve the product org, then ensure the inviter's code THERE
    // so `affiliateCodeExists(tenant, org, code)` resolves it at checkout.
    const paidId = await publishedChallenge();
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Paid', price: 20 });
    await linkChallengeProduct(T, product.productId, paidId, 1, 'user:pub');
    const info = await productForChallenge(T, paidId, 1);
    expect(info?.orgId).toBe(ORG);
    const link = await ensureAffiliateForSubject(T, info!.orgId, 'user:inviter');
    expect(link.code).toMatch(/^KT-[0-9A-F]{12}$/);
    // Idempotent — the same inviter always resolves to the same code.
    expect((await ensureAffiliateForSubject(T, info!.orgId, 'user:inviter')).code).toBe(link.code);
    // …and the affiliate really lives in the PRODUCT's org (checkout resolves it there).
    expect((await affiliateByCode(T, ORG, link.code))?.affiliateId).toBe(link.affiliateId);
  });
});

describe('GET …/challenges/:id/:version/referral-code — the route (ADR 0451 P2b)', () => {
  let server: http.Server;
  let BASE = '';
  let wsTenant = '';
  let cookie = '';
  const STORE_ORG = 'org-pfc-route';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    for (const id of ['users', 'kicktodo-core', 'kicktodo-commerce']) {
      const d = getToggleDefault(id);
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
    registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
    const ws = await createWorkspace({ name: 'KT Referral', ownerSubject: 'oidc:ref-owner' });
    wsTenant = ws.tenantId;
    const user = await upsertFromPrincipal({ tenantId: wsTenant, principalId: 'oidc:ref-inviter', source: 'oidc' });
    await createMember({ tenantId: wsTenant, orgId: wsTenant, subject: user.userId, displayName: 'Inviter', roles: ['editor'] });
    const now = Math.floor(Date.now() / 1000);
    cookie = `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: wsTenant, tier: 'user', userId: user.userId, personalTenant: 'ws:home-ref-inviter', iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    for (const id of ['users', 'kicktodo-core', 'kicktodo-commerce']) {
      const d = getToggleDefault(id);
      if (d) await saveConfig(d, 'test');
    }
  });

  interface ReferralCodeBody { code: string | null }
  const getCode = async (challengeId: string): Promise<{ status: number; body: ReferralCodeBody }> => {
    const res = await fetch(`${BASE}${KICKTODO_COMMERCE_PREFIX}/challenges/${encodeURIComponent(challengeId)}/1/referral-code`, { headers: { cookie } });
    const raw: unknown = await res.json().catch(() => null);
    const code: unknown = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'code') : undefined;
    return { status: res.status, body: { code: typeof code === 'string' ? code : null } };
  };

  it('returns { code: null } for a free challenge and mints the caller a code in the PRODUCT org for a paid one', async () => {
    const freeId = await publishedChallenge(wsTenant);
    const free = await getCode(freeId);
    expect(free.status).toBe(200);
    expect(free.body.code).toBeNull();

    const paidId = await publishedChallenge(wsTenant);
    const product = await createProduct({ tenantId: wsTenant, orgId: STORE_ORG, createdBy: 'user:pub', type: 'digital', name: 'Paid', price: 20 });
    await linkChallengeProduct(wsTenant, product.productId, paidId, 1, 'user:pub');

    const first = await getCode(paidId);
    expect(first.status).toBe(200);
    expect(first.body.code).toMatch(/^KT-[0-9A-F]{12}$/);
    const code = first.body.code!;
    // Minted in the product's org (so checkout's affiliateCodeExists resolves it)…
    expect(await affiliateByCode(wsTenant, STORE_ORG, code)).not.toBeNull();
    // …bound to a real caller subject, and stable across calls.
    expect(await resolveSubjectForAffiliateCode(wsTenant, code)).toEqual(expect.any(String));
    expect((await getCode(paidId)).body.code).toBe(code);
  });
});
