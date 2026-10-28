/**
 * ADR 0952 defect P9 — budgets go out in each platform's own unit for the AD
 * ACCOUNT's currency, read from the platform, never assumed.
 *
 * Before: Google sent minor × 10⁴ micros and TikTok/LinkedIn minor / 100 (right
 * only for 2-decimal currencies: a JPY budget 100× too small, a KWD one 10× too
 * large), and Meta passed ISO minor units through (100× too large for HUF/TWD, 10×
 * too large for BHD, whose Meta offset is 100 though ISO has 3).
 *
 * Pinned per exponent class (0: JPY, 2: USD, 3: KWD/BHD) and per Meta offset
 * class (1 vs 100, including the two classes where Meta and ISO disagree), plus
 * the fail-closed legs: an unreported currency, a currency Meta does not
 * support, and a caller's currency hint the platform contradicts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { answerCurrencyRead, currencyReads, platformRequests, fixtureCurrency } from './adsCurrencyFixture.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import {
  minorToGoogleMicros, googleMicrosToMinor, minorToMetaBudget, metaBudgetToMinor, minorToMajorString, minorToMajorNumber, isoExponent,
  META_CURRENCY_OFFSET_1, META_CURRENCY_OFFSET_100,
} from '../src/host/adsWire.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';

describe('ADR 0952 P9 — unit conversions (pure)', () => {
  it('Google micros = minor × 10^(6 − ISO exponent), and back', () => {
    expect(minorToGoogleMicros(7500, 'USD')).toBe(75_000_000);      // $75.00
    expect(minorToGoogleMicros(5000, 'JPY')).toBe(5_000_000_000);   // ¥5,000 (the old ×10⁴ gave 50,000,000 = ¥50: 100× too small)
    expect(minorToGoogleMicros(5000, 'KWD')).toBe(5_000_000);       // 5.000 KWD (the old ×10⁴ gave 50,000,000 = 50 KWD: 10× too large)
    expect(googleMicrosToMinor(5_000_000, 'KWD')).toBe(5000);
    expect(googleMicrosToMinor(5_000_000_000, 'JPY')).toBe(5000);
  });

  it('Meta uses ITS offset table, not ISO: HUF/TWD offset 1, BHD/JOD offset 100', () => {
    expect(minorToMetaBudget(5000, 'USD')).toBe(5000);     // offset 100, exp 2
    expect(minorToMetaBudget(5000, 'JPY')).toBe(5000);     // offset 1, exp 0
    expect(minorToMetaBudget(500_000, 'HUF')).toBe(5000);  // 5,000.00 Ft → 5000 (offset 1, exp 2; passthrough was 100× too large)
    expect(minorToMetaBudget(5000, 'BHD')).toBe(500);      // 5.000 BHD → 500 (offset 100, exp 3; the passthrough 5000 meant 50 BHD: 10× too large)
    expect(metaBudgetToMinor(500, 'BHD')).toBe(5000);
    expect(minorToMetaBudget(5000, 'KWD')).toBeNull();     // not a Meta ad-account currency
  });

  it('TikTok/LinkedIn major units carry the currency’s own decimals', () => {
    expect(minorToMajorNumber(5000, 'USD')).toBe(50);
    expect(minorToMajorNumber(5000, 'JPY')).toBe(5000);
    expect(minorToMajorString(5000, 'KWD')).toBe('5.000');
    expect(minorToMajorString(5000, 'USD')).toBe('50.00');
  });

  it('never defaults a currency', () => {
    expect(isoExponent(undefined)).toBeNull();
    expect(isoExponent('usd')).toBeNull();
    expect(minorToGoogleMicros(100, '')).toBeNull();
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses non-integer, negative or unsafe money %s', (value) => {
    expect(minorToGoogleMicros(value, 'USD')).toBeNull();
    expect(googleMicrosToMinor(value, 'USD')).toBeNull();
    expect(minorToMetaBudget(value, 'USD')).toBeNull();
    expect(metaBudgetToMinor(value, 'USD')).toBeNull();
    expect(minorToMajorString(value, 'USD')).toBeNull();
    expect(minorToMajorNumber(value, 'USD')).toBeNull();
  });

  it('requires exact representability and safe conversion outputs', () => {
    expect(minorToMetaBudget(500050, 'HUF')).toBeNull();
    expect(minorToMetaBudget(5005, 'BHD')).toBeNull();
    expect(googleMicrosToMinor(1, 'USD')).toBeNull();
    expect(minorToGoogleMicros(9007199254, 'JPY')).toBe(9007199254000000);
    expect(minorToGoogleMicros(9007199255, 'JPY')).toBeNull();
    expect(metaBudgetToMinor(Number.MAX_SAFE_INTEGER, 'BHD')).toBeNull();
    expect(minorToMajorString(Number.MAX_SAFE_INTEGER, 'USD')).toBe('90071992547409.91');
    expect(minorToMajorNumber(Number.MAX_SAFE_INTEGER, 'USD')).toBeNull();
    expect(minorToMajorNumber(109, 'USD')).toBe(1.09);
    expect(minorToGoogleMicros(0, 'JPY')).toBe(0);
  });

  it('rejects unknown ISO-shaped codes and non-currency ISO codes', () => {
    for (const code of ['ZZZ', 'XXX', 'XDR', 'XSU', 'XAU']) expect(isoExponent(code), code).toBeNull();
  });

  it('pins ISO 4217 exponents for the currencies the adapters convert, independent of ICU', () => {
    // ISO 4217, not CLDR display precision: ICU 78.3 (Node 22.23.4, the prod image)
    // reports HUF/COP/IDR/PKR = 0 and IQD = 0; older ICU reported TWD = 0.
    const iso: Record<string, number> = {
      HUF: 2, TWD: 2, COP: 2, IDR: 2, PKR: 2, CRC: 2, USD: 2, EUR: 2, GBP: 2, AUD: 2,
      JPY: 0, KRW: 0, CLP: 0, ISK: 0, PYG: 0, VND: 0,
      BHD: 3, JOD: 3, KWD: 3, IQD: 3, OMR: 3, TND: 3, LYD: 3,
    };
    for (const [code, exp] of Object.entries(iso)) expect(isoExponent(code), code).toBe(exp);
    // Every currency in Meta's offset tables that ISO still lists has an exponent.
    for (const code of [...META_CURRENCY_OFFSET_1, ...META_CURRENCY_OFFSET_100]) {
      if (!['LVL', 'LTL', 'SKK', 'VEF'].includes(code)) expect(isoExponent(code), code).not.toBeNull();
    }
    // The runtime's Intl is never consulted: a broken or disagreeing ICU changes nothing.
    const catalogue = vi.spyOn(Intl, 'supportedValuesOf').mockImplementation(() => { throw new Error('catalogue unavailable'); });
    const formatter = vi.spyOn(Intl, 'NumberFormat').mockImplementation(() => { throw new Error('formatter unavailable'); });
    try {
      expect(isoExponent('USD')).toBe(2);
      expect(isoExponent('HUF')).toBe(2);
      expect(minorToMetaBudget(500_000, 'HUF')).toBe(5000);
    } finally { catalogue.mockRestore(); formatter.mockRestore(); }
  });

});

const T = 'p9-t';
let srv: http.Server;
let storage: Storage;
let campaignOwner: unknown = '1';
let ownerHttpStatus = 200;
let ownerMalformed = false;
let writes: Array<{ path: string; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await __resetConnectionsStore();
  srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      if (answerCurrencyRead(url, raw, res)) return;
      if (url.includes('fields=account_id')) {
        res.writeHead(ownerHttpStatus, { 'content-type': 'application/json' });
        res.end(ownerMalformed ? '{bad' : JSON.stringify({ account_id: campaignOwner }));
        return;
      }
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url.endsWith('googleAds:search')) { res.end(JSON.stringify({ results: [{ campaign: { campaignBudget: 'customers/1/campaignBudgets/9' } }] })); return; }
      if (req.method === 'GET' && url.includes('fields=daily_budget')) { res.end(JSON.stringify({ daily_budget: '1' })); return; }
      writes.push({ path: url, body });
      if (url.endsWith(':mutate')) { res.end(JSON.stringify({ results: [{ resourceName: 'customers/1/campaignBudgets/9' }] })); return; }
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  process.env.OPENWOP_META_API_BASE = `${base}/meta`;
  process.env.OPENWOP_GOOGLE_ADS_API_BASE = `${base}/google`;
  for (const id of ['meta-ads', 'google-ads']) {
    registerProvider({ id, label: id, kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
    await createSecretConnection({ tenantId: T, provider: id, kind: 'bearer', secret: 'TOK', scope: 'user', userId: 'u1' });
  }
  await storage.insertRun({ runId: 'p9-run', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
});
afterAll(async () => {
  for (const k of ['OPENWOP_META_API_BASE', 'OPENWOP_GOOGLE_ADS_API_BASE', 'OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN']) delete process.env[k];
  fixtureCurrency.value = 'USD';
  await new Promise<void>((r) => srv.close(() => r()));
});
beforeEach(() => { writes = []; currencyReads.length = 0; platformRequests.length = 0; campaignOwner = '1'; ownerHttpStatus = 200; ownerMalformed = false; fixtureCurrency.value = 'USD'; delete fixtureCurrency.fault; });

const adapter = () => makeAdsAdapter({ storage, tenantId: T, runId: 'p9-run', actingUserId: 'u1', orgId: T });
const micros = (): string | undefined => (writes[0]?.body.operations as Array<{ update: { amountMicros: string } }> | undefined)?.[0]?.update.amountMicros;

describe('ADR 0952 P9 — live budget writes convert through the account currency the platform reports', () => {
  it('Google updateBudget: JPY, USD and KWD accounts each get the right micros', async () => {
    for (const [cur, minor, want] of [['JPY', 5000, '5000000000'], ['USD', 7500, '75000000'], ['KWD', 5000, '5000000']] as const) {
      fixtureCurrency.value = cur;
      writes = [];
      expect((await adapter().updateBudget({ platform: 'google', adAccountId: '123-456-7890', campaignId: '22', dailyBudgetMinor: minor })).outcome).toBe('updated');
      expect(micros()).toBe(want);
    }
    expect(currencyReads.length).toBe(3);
  });

  it('Meta updateBudget: HUF (offset 1) and BHD (offset 100) use Meta’s offsets; an unsupported currency never writes', async () => {
    fixtureCurrency.value = 'HUF';
    expect((await adapter().updateBudget({ platform: 'meta', adAccountId: 'act_1', campaignId: '11', dailyBudgetMinor: 500_000 })).outcome).toBe('updated');
    expect(writes[0]?.body).toEqual({ daily_budget: 5000 });
    fixtureCurrency.value = 'BHD';
    writes = [];
    await adapter().updateBudget({ platform: 'meta', adAccountId: 'act_1', campaignId: '11', dailyBudgetMinor: 5000 });
    expect(writes[0]?.body).toEqual({ daily_budget: 500 });
    fixtureCurrency.value = 'KWD';
    writes = [];
    expect(await adapter().updateBudget({ platform: 'meta', adAccountId: 'act_1', campaignId: '11', dailyBudgetMinor: 5000 })).toEqual({ outcome: 'failed', error: 'currency_unsupported:KWD' });
    expect(writes).toHaveLength(0);
  });

  it('a currency the platform does not report is a failure with no write, never a default', async () => {
    fixtureCurrency.value = 'nope';
    expect(await adapter().updateBudget({ platform: 'google', adAccountId: '1', campaignId: '22', dailyBudgetMinor: 5000 })).toEqual({ outcome: 'failed', error: 'account_currency_unknown' });
    expect(writes).toHaveLength(0);
  });

  it('publishAd: a caller currency hint the platform contradicts is refused before any create', async () => {
    fixtureCurrency.value = 'JPY';
    const out = await adapter().publishAd({
      platform: 'google', briefId: 'b-p9', adAccountId: '123', campaignName: 'C', copy: { headline: 'H', description: 'D' },
      dailyBudgetMinor: 5000, landingUrl: 'https://example.com', euPoliticalAdvertising: 'does_not_contain', accountCurrency: 'USD',
    });
    expect(out).toEqual({ outcome: 'failed', error: 'currency_mismatch:JPY' });
    expect(writes).toHaveLength(0);
  });

  it('a different accessible Meta account cannot supply currency for the target campaign', async () => {
    fixtureCurrency.value = 'JPY';
    campaignOwner = '2';
    expect(await adapter().updateBudget({ platform: 'meta', adAccountId: 'act_1', campaignId: '11', dailyBudgetMinor: 5000 })).toEqual({ outcome: 'failed', error: 'campaign_account_mismatch' });
    expect(currencyReads).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(platformRequests).toHaveLength(1);
  });

  it.each(['missing', 'malformed', 'http error'] as const)('Meta %s ownership refuses before currency lookup and writes', async (fault) => {
    if (fault === 'missing') campaignOwner = undefined;
    if (fault === 'malformed') ownerMalformed = true;
    if (fault === 'http error') ownerHttpStatus = 503;
    expect(await adapter().updateBudget({ platform: 'meta', adAccountId: 'act_1', campaignId: '11', dailyBudgetMinor: 5000 })).toEqual({ outcome: 'failed', error: 'campaign_account_unreadable' });
    expect(currencyReads).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it.each([['act_1junk', '11'], ['act_1', '11junk']])('Meta malformed target %s/%s refuses without platform I/O', async (adAccountId, campaignId) => {
    expect(await adapter().updateBudget({ platform: 'meta', adAccountId, campaignId, dailyBudgetMinor: 5000 })).toEqual({ outcome: 'failed', error: 'invalid_campaign_account_target' });
    expect(platformRequests).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it.each([['HUF', 500050], ['BHD', 5005]] as const)('Meta %s unrepresentable budget refuses without writes', async (currency, amount) => {
    fixtureCurrency.value = currency;
    expect(await adapter().updateBudget({ platform: 'meta', adAccountId: 'act_1', campaignId: '11', dailyBudgetMinor: amount })).toEqual({ outcome: 'failed', error: 'budget_not_representable' });
    expect(writes).toHaveLength(0);
  });

  it('dry-run budget changes make zero ownership, currency or mutation requests', async () => {
    for (const platform of ['meta', 'google'] as const) {
      expect((await adapter().updateBudget({ platform, adAccountId: '1', campaignId: '11', dailyBudgetMinor: 5000, dryRun: true })).outcome).toBe('preview');
    }
    expect(platformRequests).toHaveLength(0);
    expect(currencyReads).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });


  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('adapter entrypoints refuse invalid money %s without any platform request', async (amount) => {
    expect(await adapter().updateBudget({ platform: 'google', adAccountId: '1', campaignId: '22', dailyBudgetMinor: amount })).toEqual({ outcome: 'failed', error: 'invalid_budget' });
    expect(await adapter().publishAd({ platform: 'google', adAccountId: '1', briefId: 'invalid-money', campaignName: 'Invalid', copy: { headline: 'H' }, dailyBudgetMinor: amount })).toEqual({ outcome: 'failed', error: 'invalid_budget' });
    expect(platformRequests).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it.each(['http', 'malformed', 'business'] as const)('a %s currency response cannot cause a budget mutation', async (fault) => {
    fixtureCurrency.fault = fault;
    try {
      const result = await adapter().updateBudget({ platform: 'google', adAccountId: '1', campaignId: '22', dailyBudgetMinor: 5000 });
      expect(result.outcome).toBe('failed');
      expect(currencyReads).toHaveLength(1);
      expect(platformRequests).toHaveLength(1);
      expect(writes).toHaveLength(0);
    } finally { delete fixtureCurrency.fault; }
  });

});

describe('ADR 0952 residual (a) — the spend threshold is compared only in its own currency', () => {
  it('USD threshold vs a USD account compares as before; vs a JPY account it asks (no FX); an explicit JPY threshold compares in yen', async () => {
    await setGovernancePolicy(T, { adSpend: { approvalThresholdMinor: 10_000 } }, 'test'); // $100.00 (absent currency = USD)
    fixtureCurrency.value = 'USD';
    expect((await adapter().updateBudget({ platform: 'google', adAccountId: '1', campaignId: '22', dailyBudgetMinor: 5000 })).outcome).toBe('updated'); // $50 < $100
    // ¥5,000 is NOT 5,000 cents: a different account currency is never compared.
    fixtureCurrency.value = 'JPY';
    writes = [];
    expect((await adapter().updateBudget({ platform: 'google', adAccountId: '1', campaignId: '22', dailyBudgetMinor: 5000 })).outcome).toBe('requires_approval');
    expect(writes).toHaveLength(0);
    // A yen threshold compares yen to yen.
    await setGovernancePolicy(T, { adSpend: { approvalThresholdMinor: 10_000, approvalThresholdCurrency: 'JPY' } }, 'test');
    expect((await adapter().updateBudget({ platform: 'google', adAccountId: '1', campaignId: '23', dailyBudgetMinor: 5000 })).outcome).toBe('updated');
    expect((await adapter().updateBudget({ platform: 'google', adAccountId: '1', campaignId: '24', dailyBudgetMinor: 20_000 })).outcome).toBe('requires_approval');
    await setGovernancePolicy(T, { adSpend: {} }, 'test');
    fixtureCurrency.value = 'USD';
  });
});

