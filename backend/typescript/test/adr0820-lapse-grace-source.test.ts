/**
 * ADR 0820 §7 — billing registers the grace-START source for the public-runtime
 * owner-lapse policy (`host/publicLapse.ts` `registerEntitlementEndedAtSource`).
 *
 * Without it the grace clock starts at the first refusal the host OBSERVES, so an
 * owner whose bundle ended a month ago gets a full fresh window the first time a
 * visitor arrives. With it, the clock starts when billing says coverage ended.
 *
 * Boots `createApp`, so billing's `registerRoutes` performs the registration (and
 * the tenant entitlement check) exactly as in production. Each test uses its own
 * tenant: verdicts are cached per (feature, tenant) for a minute.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { bundleFeatureIds, knownBundleIds } from '../src/host/featureBundles.js';
import { PUBLIC_LAPSE_GRACE_ENV, ownerLapseVerdict } from '../src/host/publicLapse.js';
import { __seedBundleGrant, entitlementEndedAt, importBillingState } from '../src/features/billing/billingService.js';

const DAY = 86_400_000;
const FEATURE = 'docs'; // a sellable bundle feature on main
const BUNDLE = knownBundleIds().find((b) => bundleFeatureIds(b).includes(FEATURE)) ?? '';
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString();
const closeTo = (iso: string | undefined, expectedMs: number): void => {
  expect(iso).toBeDefined();
  expect(Math.abs(Date.parse(iso as string) - expectedMs)).toBeLessThan(5_000);
};

let server: http.Server;
let app: Express;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  await saveConfig({ id: 'billing', status: 'on', bucketUnit: 'tenant', salt: 'billing' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => {
  // A narrowed host: the free plan holds no sellable feature, pro holds every one.
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: [], pro: '*' });
  process.env[PUBLIC_LAPSE_GRACE_ENV] = '14';
});
afterEach(() => {
  for (const k of ['OPENWOP_BILLING_PLAN_FEATURES', 'OPENWOP_BILLING_PAST_DUE_GRACE_DAYS', PUBLIC_LAPSE_GRACE_ENV]) delete process.env[k];
});

describe('ADR 0820 §7 — the grace clock starts at the grant end, not the first refusal', () => {
  it('fixture sanity: the feature is in a bundle', () => {
    expect(BUNDLE).not.toBe('');
  });

  it('POSITIVE control: an owner with an active grant is served as entitled', async () => {
    await __seedBundleGrant('t-active', BUNDLE, { status: 'active', stripeStatus: 'active', updatedAt: ago(40) });
    expect(await ownerLapseVerdict(FEATURE, 't-active')).toEqual({ serve: true, reason: 'entitled' });
  });

  it('a grant canceled 20 days ago is LAPSED on the very first refusal (14-day grace)', async () => {
    const ended = ago(20);
    await __seedBundleGrant('t-canceled-old', BUNDLE, { status: 'canceled', stripeStatus: 'canceled', updatedAt: ended });
    const v = await ownerLapseVerdict(FEATURE, 't-canceled-old');
    expect(v.reason).toBe('lapsed');
    expect(v.serve).toBe(false);
    closeTo(v.graceEndsAt, Date.parse(ended) + 14 * DAY);
  });

  it('a grant canceled 3 days ago is in grace, ending 14 days after the cancel, not after now', async () => {
    const ended = ago(3);
    await __seedBundleGrant('t-canceled-new', BUNDLE, { status: 'canceled', stripeStatus: 'canceled', updatedAt: ended });
    const v = await ownerLapseVerdict(FEATURE, 't-canceled-new');
    expect(v.reason).toBe('grace');
    closeTo(v.graceEndsAt, Date.parse(ended) + 14 * DAY);
  });

  it('a past_due plan ended when its past-due grace ended (pastDueSince + N days)', async () => {
    process.env.OPENWOP_BILLING_PAST_DUE_GRACE_DAYS = '3';
    const since = ago(20);
    await importBillingState({ subscriptions: [{ tenantId: 't-pd', planTier: 'pro', status: 'past_due', pastDueSince: since, updatedAt: ago(1) }] });
    expect(await entitlementEndedAt('t-pd', FEATURE)).toBe(new Date(Date.parse(since) + 3 * DAY).toISOString());
    expect((await ownerLapseVerdict(FEATURE, 't-pd')).reason).toBe('lapsed');
  });

  it('a canceled plan ended at its row updatedAt', async () => {
    const ended = ago(2);
    await importBillingState({ subscriptions: [{ tenantId: 't-plan-canceled', planTier: 'pro', status: 'canceled', updatedAt: ended }] });
    expect(await entitlementEndedAt('t-plan-canceled', FEATURE)).toBe(ended);
  });

  it('coverage ended at the LATEST covering end (a plan that outlived the grant)', async () => {
    await __seedBundleGrant('t-both', BUNDLE, { status: 'canceled', stripeStatus: 'canceled', updatedAt: ago(30) });
    const planEnd = ago(5);
    await importBillingState({ subscriptions: [{ tenantId: 't-both', planTier: 'pro', status: 'canceled', updatedAt: planEnd }] });
    expect(await entitlementEndedAt('t-both', FEATURE)).toBe(planEnd);
  });

  it('UNKNOWN ends fall back to the observed clock: a legacy past_due with no pastDueSince, a plan that never held it', async () => {
    await importBillingState({ subscriptions: [{ tenantId: 't-legacy', planTier: 'pro', status: 'past_due', updatedAt: ago(30) }] });
    expect(await entitlementEndedAt('t-legacy', FEATURE)).toBeNull();
    const v = await ownerLapseVerdict(FEATURE, 't-legacy');
    expect(v.reason).toBe('grace');
    closeTo(v.graceEndsAt, Date.now() + 14 * DAY);
    // A tenant on the free plan that never bought anything: no billing timestamp.
    expect(await entitlementEndedAt('t-never', FEATURE)).toBeNull();
    // Never-paid grants are skipped (they covered nothing).
    await __seedBundleGrant('t-incomplete', BUNDLE, { status: 'canceled', stripeStatus: 'incomplete_expired', updatedAt: ago(30) });
    expect(await entitlementEndedAt('t-incomplete', FEATURE)).toBeNull();
  });
});
