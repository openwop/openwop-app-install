/**
 * MyndHyve R2 — account self-delete (`DELETE /host/openwop-app/account`) stops
 * the tenant's Stripe billing BEFORE it wipes the rows that name it, and emits
 * `host.users.user.erased` once the caller's user row is gone.
 *
 * A mock Stripe API (`OPENWOP_STRIPE_API_BASE`) answers the subscription read
 * and cancel; no live call is made. What is asserted:
 *  - the open plan subscription AND an open bundle add-on are canceled at
 *    Stripe, an already-canceled one is not canceled again, and the counts reach
 *    the response and the `account.delete` audit row;
 *  - a Stripe failure refuses the delete (503) and wipes NOTHING (the billing
 *    row and the user row survive), and a retry then succeeds;
 *  - with an open subscription and no Stripe key the delete is refused (503);
 *  - an account with no subscription deletes without touching Stripe;
 *  - `host.users.user.erased` fires for the caller's own user id, after the wipe;
 *  - ADR 0833 D7 parity: an approved-but-uncollected CLI login in a workspace
 *    the person is a MEMBER of is withdrawn (the poll returns `denied`);
 *  - a refused delete (503) revokes nothing: their key still authenticates and
 *    their row stays active (review of #5001, finding 1);
 *  - the cancel webhook (`customer.subscription.deleted`) writes no billing row
 *    back for the erased tenant (finding 3);
 *  - a failure AFTER the disable (revocation or wipe) re-enables the row, so the
 *    person can sign in and retry, and a subscription Stripe canceled is ended
 *    locally too (re-review M1/M2).
 *
 * Sabotage that turns it red (`routes/account.ts`): the
 * `cancelTenantStripeSubscriptions` call removed or moved after the wipe; the
 * `userErased(…)` call removed; the `notifySubjectErased(…)` call removed or
 * moved before the Stripe cancel. (`billingService.ts`) the erased-subscription
 * guard in `applySubscriptionEvent` removed.
 * (`billingService.ts`): the bundle-grant loop
 * removed; the `isTerminalStatus` skip removed; the missing-key throw removed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const erased: Array<{ userId: string; tenantId: string }> = [];
vi.mock('../src/features/users/emit.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/features/users/emit.js')>();
  return {
    ...real,
    userErased: (input: { userId: string; tenantId: string; outcome: 'deleted' }) => {
      erased.push({ userId: input.userId, tenantId: input.tenantId });
      real.userErased(input);
    },
  };
});

import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { setSecret } from '../src/byok/secretResolver.js';
import { bumpSessionEpoch, getUser } from '../src/features/users/usersService.js';
import { issueApiKey, verifyApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { decideCliLogin, pollCliLogin, startCliLogin } from '../src/features/developer-keys/cliLogin.js';
import { createMember, createWorkspace } from '../src/host/accessControlService.js';
import { registerSubjectErasedHandler } from '../src/host/delegatedSubject.js';
import { registerTenantPurgeHook } from '../src/host/hostExtPersistence.js';
import {
  __resetBilling, __seedBundleGrant, getBundleEntitlements, getSubscription, importBillingState, processStripeEvent,
} from '../src/features/billing/billingService.js';

const STRIPE_KEY = 'sk_test_r2_self_delete';

let server: http.Server;
let BASE = '';
let stripe: http.Server;
let storage: Storage;

const subs = new Map<string, { id: string; status: string; customer?: string; metadata?: Record<string, string> }>();
const deletes: string[] = [];
let failCancel = false;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  stripe = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const m = /^\/v1\/subscriptions\/([^?]+)/.exec(req.url ?? '');
      const sub = m ? subs.get(decodeURIComponent(m[1]!)) : undefined;
      if (m && req.method === 'GET') return sub ? send(200, sub) : send(404, { error: { message: 'No such subscription', code: 'resource_missing' } });
      if (m && req.method === 'DELETE') {
        if (failCancel) return send(500, { error: { message: 'stripe is down' } });
        if (!sub) return send(404, { error: { message: 'No such subscription', code: 'resource_missing' } });
        deletes.push(sub.id);
        sub.status = 'canceled';
        return send(200, sub);
      }
      return send(404, { error: { message: `unmocked ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => {
  for (const k of ['OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_STRIPE_API_BASE']) delete process.env[k];
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => stripe.close(() => r()));
});

beforeEach(async () => {
  await __resetBilling();
  subs.clear();
  deletes.length = 0;
  erased.length = 0;
  failCancel = false;
  await setSecret('billing:stripe-key', STRIPE_KEY);
});

/** Sign in a fresh person; returns their cookie, user id and personal tenant. */
async function signIn(subject: string): Promise<{ cookie: string; userId: string; tenantId: string }> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject, displayName: subject }),
  });
  expect(res.status).toBe(201);
  const { user } = (await res.json()) as { user: { userId: string; tenantId: string } };
  const cookie = (getSetCookies(res.headers) as string[]).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean)!;
  expect(user.tenantId.startsWith('user:')).toBe(true);
  return { cookie, userId: user.userId, tenantId: user.tenantId };
}

async function deleteAccount(cookie: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/host/openwop-app/account`, { method: 'DELETE', headers: { cookie } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function seedPlan(tenantId: string, subId: string, status = 'active'): Promise<void> {
  subs.set(subId, { id: subId, status });
  await importBillingState({ subscriptions: [{
    tenantId, planTier: 'pro', status: status as 'active', stripeCustomerId: `cus_${subId}`, stripeSubscriptionId: subId, updatedAt: new Date().toISOString(),
  }] });
}

describe('MyndHyve R2 — self-delete cancels Stripe billing first', () => {
  it('cancels the open plan and bundle subscriptions, skips an ended one, and reports the count', async () => {
    const me = await signIn('oidc:r2-cancel');
    await seedPlan(me.tenantId, 'sub_plan');
    subs.set('sub_crm', { id: 'sub_crm', status: 'active' });
    await __seedBundleGrant(me.tenantId, 'crm', { status: 'active', stripeSubscriptionId: 'sub_crm', stripeStatus: 'active', updatedAt: new Date().toISOString() });
    // Open locally, already canceled at Stripe (a missed webhook): read, not re-canceled.
    subs.set('sub_old', { id: 'sub_old', status: 'canceled' });
    await __seedBundleGrant(me.tenantId, 'content', { status: 'active', stripeSubscriptionId: 'sub_old', stripeStatus: 'active', updatedAt: new Date().toISOString() });

    const res = await deleteAccount(me.cookie);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.stripeSubscriptionsCanceled).toBe(2);
    expect(deletes.sort()).toEqual(['sub_crm', 'sub_plan']);
    expect(subs.get('sub_plan')?.status).toBe('canceled');

    const audit = (await storage.listAudit({ actionPrefix: 'account.delete' })).find((r) => r.resource === me.tenantId);
    expect(audit?.payload).toMatchObject({ stripeSubscriptionsCanceled: 2, stripeSubscriptionsAlreadyEnded: 1, stripeSubscriptionsUnknown: 0 });
    // The billing row is gone with the account.
    expect((await getSubscription(me.tenantId)).stripeSubscriptionId).toBeUndefined();
  });

  it('a Stripe failure refuses the delete (503) and wipes nothing; the retry succeeds', async () => {
    const me = await signIn('oidc:r2-fail');
    await seedPlan(me.tenantId, 'sub_fail');
    failCancel = true;
    const refused = await deleteAccount(me.cookie);
    expect(refused.status).toBe(503);
    expect(refused.body.error).toBe('service_unavailable');
    expect((await getSubscription(me.tenantId)).stripeSubscriptionId).toBe('sub_fail');
    expect(await getUser(me.userId)).not.toBeNull();
    expect(erased).toEqual([]);

    failCancel = false;
    const ok = await deleteAccount(me.cookie);
    expect(ok.status).toBe(200);
    expect(deletes).toEqual(['sub_fail']);
  });

  it('with an open subscription and no Stripe key, the delete is refused (503)', async () => {
    const me = await signIn('oidc:r2-nokey');
    await seedPlan(me.tenantId, 'sub_nokey');
    await setSecret('billing:stripe-key', '');
    const refused = await deleteAccount(me.cookie);
    expect(refused.status).toBe(503);
    expect((refused.body.details as Record<string, unknown>)?.billing).toBe('stripe_key_missing');
    expect((await getSubscription(me.tenantId)).stripeSubscriptionId).toBe('sub_nokey');
  });

  it('an account with no subscription deletes without calling Stripe', async () => {
    const me = await signIn('oidc:r2-free');
    await setSecret('billing:stripe-key', '');
    const res = await deleteAccount(me.cookie);
    expect(res.status).toBe(200);
    expect(res.body.stripeSubscriptionsCanceled).toBe(0);
    expect(deletes).toEqual([]);
  });
});

describe('MyndHyve R2 — host.users.user.erased on self-delete', () => {
  it('fires once, for the caller\'s own user id and personal tenant, after the row is gone', async () => {
    const me = await signIn('oidc:r2-erased');
    expect(await getUser(me.userId)).not.toBeNull();
    const res = await deleteAccount(me.cookie);
    expect(res.status).toBe(200);
    expect(await getUser(me.userId)).toBeNull();
    expect(erased).toEqual([{ userId: me.userId, tenantId: me.tenantId }]);
  });
});

describe('self-delete revokes what the account delegated in other workspaces (ADR 0833 D7 parity)', () => {
  it('an approved-but-uncollected CLI login in a workspace the person belongs to is withdrawn', async () => {
    const me = await signIn('oidc:r2-cli');
    // A REAL shared workspace: someone else owns it, the person is a member.
    const ws = await createWorkspace({ name: 'R2 Team', ownerSubject: 'oidc:r2-team-owner' });
    await createMember({ tenantId: ws.tenantId, orgId: ws.orgId, subject: me.userId, displayName: 'r2', roles: ['editor'] });
    const login = await startCliLogin({ label: 'laptop' });
    await decideCliLogin(login.userCode, { approve: true, subject: me.userId, tenantId: ws.tenantId });

    const res = await deleteAccount(me.cookie);
    expect(res.status).toBe(200);
    // Polled AFTER the delete: without the revocation this mints a live key
    // under the deleted account (the membership cascade cannot see a login
    // that has no key yet).
    expect(await pollCliLogin(login.deviceCode)).toEqual({ status: 'denied' });
  });

  it('a refused delete (503: open subscription, no Stripe key) revokes NOTHING and leaves the person signed-in-able', async () => {
    const me = await signIn('oidc:r2-503-keys');
    const ws = await createWorkspace({ name: 'R2 Keys', ownerSubject: 'oidc:r2-keys-owner' });
    await createMember({ tenantId: ws.tenantId, orgId: ws.orgId, subject: me.userId, displayName: 'r2', roles: ['editor'] });
    const { token } = await issueApiKey({ tenantId: ws.tenantId, name: 'ci', createdBy: me.userId });
    await seedPlan(me.tenantId, 'sub_503_keys');
    await setSecret('billing:stripe-key', '');

    const refused = await deleteAccount(me.cookie);
    expect(refused.status).toBe(503);
    expect(await verifyApiKey(token)).not.toBeNull();
    expect((await getUser(me.userId))?.status).toBe('active');
    // The same session still works: nothing was ended.
    expect((await deleteAccount(me.cookie)).status).toBe(503);
  });
});

describe('the cancel webhook does not write billing rows back for the erased tenant', () => {
  it('customer.subscription.deleted for a self-delete-canceled subscription is ignored', async () => {
    const me = await signIn('oidc:r2-webhook');
    await seedPlan(me.tenantId, 'sub_wh');
    // As Stripe returns them: our checkout stamps `metadata` on the subscription
    // (ADR 0419), which is what maps the webhook back to the erased tenant.
    subs.set('sub_wh', { id: 'sub_wh', status: 'active', customer: 'cus_sub_wh', metadata: { tenantId: me.tenantId, kind: 'plan' } });
    subs.set('sub_wh_crm', { id: 'sub_wh_crm', status: 'active', customer: 'cus_sub_wh_crm', metadata: { tenantId: me.tenantId, bundleId: 'crm' } });
    await __seedBundleGrant(me.tenantId, 'crm', { status: 'active', stripeSubscriptionId: 'sub_wh_crm', stripeStatus: 'active', updatedAt: new Date().toISOString() });
    expect((await deleteAccount(me.cookie)).status).toBe(200);

    for (const [i, id] of ['sub_wh', 'sub_wh_crm'].entries()) {
      const r = await processStripeEvent(me.tenantId, {
        id: `evt_r2_wh_${i}`, type: 'customer.subscription.deleted',
        data: { object: { id, status: 'canceled', customer: `cus_${id}`, metadata: { tenantId: me.tenantId, ...(i ? { bundleId: 'crm' } : { kind: 'plan' }) } } },
      }, { stripeKey: STRIPE_KEY });
      expect(r.status).toBe('ignored');
    }
    const after = await getSubscription(me.tenantId);
    expect(after.stripeSubscriptionId).toBeUndefined();
    expect(after.stripeCustomerId).toBeUndefined();
    expect((await getBundleEntitlements(me.tenantId)).bundles).toEqual({});
  });
});

describe('a delete that fails after the disable does not lock the person out (review M1/M2)', () => {
  it('a failed revocation: 500, the row is active again, and the canceled plan and grant are no longer entitling', async () => {
    let failRevoke = true;
    // Flag-gated, so it stays inert for anything registered after this test.
    registerSubjectErasedHandler(async () => { if (failRevoke) throw new Error('revocation store down'); });
    try {
      const me = await signIn('oidc:r2-revoke-fail');
      await seedPlan(me.tenantId, 'sub_rf');
      subs.set('sub_rf_crm', { id: 'sub_rf_crm', status: 'active' });
      await __seedBundleGrant(me.tenantId, 'crm', { status: 'active', stripeSubscriptionId: 'sub_rf_crm', stripeStatus: 'active', updatedAt: new Date().toISOString() });

      const res = await deleteAccount(me.cookie);
      expect(res.status).toBe(500);
      expect(String(res.body.message)).toMatch(/did not finish/);
      expect((await getUser(me.userId))?.status).toBe('active');
      expect(erased).toEqual([]);
      // M2 — Stripe canceled both; the local rows say so (the webhook for them
      // is now a no-op, so nothing else would ever end them).
      expect(deletes.sort()).toEqual(['sub_rf', 'sub_rf_crm']);
      expect((await getSubscription(me.tenantId)).status).toBe('canceled');
      expect((await getBundleEntitlements(me.tenantId)).bundles.crm?.status).toBe('canceled');
    } finally {
      failRevoke = false;
    }
  });

  it('the re-enable never undoes a change made meanwhile (an admin disable mid-delete stays)', async () => {
    let target: string | null = null;
    registerSubjectErasedHandler(async (subject) => {
      if (target !== subject.userId) return;
      await bumpSessionEpoch(subject.userId, (row) => ({ ...row, status: 'disabled' })); // the admin's own disable
      throw new Error('revocation store down');
    });
    try {
      const me = await signIn('oidc:r2-admin-race');
      target = me.userId;
      expect((await deleteAccount(me.cookie)).status).toBe(500);
      expect((await getUser(me.userId))?.status).toBe('disabled');
    } finally {
      target = null;
    }
  });

  it('a failed WIPE: the row is re-enabled, the person signs in again, and the retry deletes', async () => {
    let failWipe = true;
    registerTenantPurgeHook('test:r2-wipe-fail', async () => { if (failWipe) throw new Error('postgres hiccup'); return 0; });
    try {
      const me = await signIn('oidc:r2-wipe-fail');
      const refused = await deleteAccount(me.cookie);
      expect(refused.status).toBe(500);
      expect((await getUser(me.userId))?.status).toBe('active');
      failWipe = false;
      const again = await signIn('oidc:r2-wipe-fail'); // the old session was ended by the epoch bump
      expect(again.userId).toBe(me.userId);
      const ok = await deleteAccount(again.cookie);
      expect(ok.status).toBe(200);
      expect(await getUser(me.userId)).toBeNull();
    } finally {
      failWipe = false;
    }
  });
});
