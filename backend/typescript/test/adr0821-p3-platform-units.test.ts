/**
 * ADR 0821 D3 / P3 — non-token platform spend metered into credits.
 *
 * Pins:
 *   1. an UNSET rate draws nothing (today's behaviour) but still records the units;
 *   2. a set rate draws `rate × quantity` credits, plan allowance before balance;
 *   3. an exempt tenant is never drawn; a malformed rate table draws nothing;
 *   4. the per-site wiring: code-exec seconds (beside the exec budget), web-search
 *      queries ONLY on the platform's key (positive control: a tenant BYOK key is
 *      not metered), the image gateway's key-source report, and the chat-widget's
 *      "opened a conversation" signal.
 *
 * Tracker TST-BUL-5. Sabotage-witnessed (w62): red when an exempt tenant is
 * drawn, a non-positive rate is accepted, units are not recorded, the plan
 * allowance is not drawn first, a site's featureId or meter call is dropped, a
 * tenant's OWN web-search key is metered as platform spend, the image gateway
 * misreports the key source, or the widget stops flagging a new session.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setManagedBalanceProvider } from '../src/host/managedBalanceHook.js';
import { registerPlanLimitsResolver } from '../src/host/planLimitsSeam.js';
import { __clearFeatureSpendForTests, creditRates, listFeatureSpendForTenant, meterPlatformUnits, planAllowanceRemaining } from '../src/host/managedCredits.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { createSandboxRunner } from '../src/host/sandboxAdapter.js';
import { createWebResearchSurface } from '../src/host/webResearchSurface.js';
import { dispatchImageGeneration } from '../src/host/imageProviderAdapter.js';
import { checkWidgetTurn } from '../src/features/chat-widget/capsTracker.js';
import type { WidgetConfig } from '../src/features/chat-widget/widgetService.js';
import { clearAllSecrets, setSecret } from '../src/byok/secretResolver.js';

let server: http.Server;
let URL_BASE = '';
let draws: number[] = [];

function fakeBalance(initial: number): void {
  let bal = initial;
  draws = [];
  setManagedBalanceProvider({ available: async () => bal, draw: async (_t, n) => { const d = Math.min(n, bal); bal -= d; draws.push(d); return d; } });
}

beforeAll(async () => {
  // Register toggle defaults the way boot does. Once a metered site is itself feature-gated
  // (ADR 0820 §8: code-exec resolves its own toggle in createSandboxRunner), an unregistered
  // toggle resolves null and fail-closes, so the metering under test would never be reached.
  for (const f of BACKEND_FEATURES) {
    if (f.toggleDefault) registerToggleDefault(f.toggleDefault);
    for (const t of f.extraToggleDefaults ?? []) registerToggleDefault(t);
  }
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url?.startsWith('/run')) res.end(JSON.stringify({ exitCode: 0, stdout: 'ok', stderr: '', files: [] }));
    else if (req.url?.startsWith('/search')) res.end(JSON.stringify({ web: { results: [{ url: 'https://example.com/a', title: 'A', description: 'a' }] } }));
    else res.end(JSON.stringify({ images: [{ base64: 'aGk=', mimeType: 'image/png' }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { URL_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }));
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
});
afterEach(async () => {
  await __clearFeatureSpendForTests();
  setManagedBalanceProvider(null);
  registerPlanLimitsResolver(null);
  for (const k of ['OPENWOP_BILLING_CREDIT_RATES', 'OPENWOP_BILLING_TOKENS_PER_CREDIT', 'OPENWOP_BILLING_EXEMPT_TENANTS', 'OPENWOP_CODE_EXEC_ENDPOINT',
    'OPENWOP_WEBSEARCH_API_KEY', 'OPENWOP_WEBSEARCH_BASE_URL', 'OPENWOP_WEBSEARCH_ENGINE', 'OPENWOP_WEBHOOK_ALLOW_PRIVATE', 'OPENWOP_IMAGE_PROVIDER_ENDPOINT']) delete process.env[k];
  __resetHostExtPersistence();
});

describe('meterPlatformUnits — the rate table', () => {
  it('an unset rate draws nothing (today) but records the units for measurement', async () => {
    fakeBalance(10_000);
    expect(await meterPlatformUnits({ tenantId: 'user:u1', unit: 'ttsChar', quantity: 400, featureId: 'voice' })).toBe(0);
    expect(draws).toEqual([]);
    const row = (await listFeatureSpendForTenant('user:u1'))[0]!;
    expect(row).toMatchObject({ featureId: 'voice', chargedTokens: 0, units: { ttsChar: 400 } });
  });

  it('a set rate draws rate × quantity credits, plan allowance before balance', async () => {
    process.env.OPENWOP_BILLING_TOKENS_PER_CREDIT = '100';
    process.env.OPENWOP_BILLING_CREDIT_RATES = JSON.stringify({ image: 4 }); // 4 credits = 400 token-eq per image
    registerPlanLimitsResolver(async () => ({ aiCreditsMonthly: 5 })); // 500 token-eq / month
    fakeBalance(10_000);
    expect(await meterPlatformUnits({ tenantId: 'user:u2', unit: 'image', quantity: 2, featureId: 'media' })).toBe(800);
    expect(await planAllowanceRemaining('user:u2')).toBe(0); // 500 from the plan
    expect(draws).toEqual([300]); // the remaining 300 from the balance
  });

  it('an exempt tenant is never drawn; a malformed table draws nothing', async () => {
    process.env.OPENWOP_BILLING_CREDIT_RATES = JSON.stringify({ webSearch: 1 });
    process.env.OPENWOP_BILLING_EXEMPT_TENANTS = '__showcase__';
    fakeBalance(10_000);
    expect(await meterPlatformUnits({ tenantId: '__showcase__', unit: 'webSearch', quantity: 3 })).toBe(0);
    expect(draws).toEqual([]);
    // Positive control: a non-exempt tenant IS drawn at the same rate.
    expect(await meterPlatformUnits({ tenantId: 'user:u3', unit: 'webSearch', quantity: 3 })).toBe(3000);
    process.env.OPENWOP_BILLING_CREDIT_RATES = '{not json';
    expect(creditRates()).toEqual({});
    process.env.OPENWOP_BILLING_CREDIT_RATES = JSON.stringify({ ttsChar: -1, image: 'x', bogus: 3 });
    expect(creditRates()).toEqual({});
  });
});

describe('per-site wiring', () => {
  it('code exec: each run meters whole seconds beside the daily budget', async () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = `${URL_BASE}/run`;
    process.env.OPENWOP_BILLING_CREDIT_RATES = JSON.stringify({ codeExecSecond: 1 });
    fakeBalance(1_000_000);
    const runner = createSandboxRunner('user:cx')!;
    await runner({ language: 'python', code: 'print(1)' });
    const row = (await listFeatureSpendForTenant('user:cx')).find((r) => r.featureId === 'code-exec')!;
    const seconds = row.units?.codeExecSecond ?? 0;
    expect(seconds).toBeGreaterThanOrEqual(1);
    // rate 1 credit/second × the default 1000 token-equivalents per credit.
    expect(draws).toEqual([seconds * 1000]);
  });

  it('web search: a query on the PLATFORM key is metered as `webSearch`', async () => {
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'host-key';
    process.env.OPENWOP_WEBSEARCH_BASE_URL = `${URL_BASE}/search`;
    process.env.OPENWOP_WEBSEARCH_ENGINE = 'brave';
    const r = await createWebResearchSurface({ tenantId: 'user:ws1' }).search({ query: 'q', maxResults: 3 });
    expect(r.engine).toBe('brave');
    expect((await listFeatureSpendForTenant('user:ws1')).find((x) => x.featureId === 'web-research')?.units).toEqual({ webSearch: 1 });
  });

  it('web search: the tenant\'s OWN key is never metered (it is the tenant\'s spend)', async () => {
    const prevEphemeral = process.env.OPENWOP_BYOK_EPHEMERAL;
    process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'host-key';
    process.env.OPENWOP_WEBSEARCH_BASE_URL = `${URL_BASE}/search`;
    process.env.OPENWOP_WEBSEARCH_ENGINE = 'brave';
    try {
      // An org tenant (not `user:`/`ws:`), so the ephemeral store accepts the key without KMS.
      await setSecret('web-search', 'tenant-own-key', { tenantId: 'org:ws3-0821' });
      const r = await createWebResearchSurface({ tenantId: 'org:ws3-0821' }).search({ query: 'q', maxResults: 3 });
      // Positive control: the live stub served the query (not the demo result).
      expect(r.engine).toBe('brave');
      expect(await listFeatureSpendForTenant('org:ws3-0821')).toEqual([]);
    } finally {
      await clearAllSecrets();
      if (prevEphemeral === undefined) delete process.env.OPENWOP_BYOK_EPHEMERAL; else process.env.OPENWOP_BYOK_EPHEMERAL = prevEphemeral;
    }
  });

  it('web search: no live key ⇒ nothing metered (the demo result is free)', async () => {
    await createWebResearchSurface({ tenantId: 'user:ws2' }).search({ query: 'q', maxResults: 3 });
    expect(await listFeatureSpendForTenant('user:ws2')).toEqual([]);
  });

  it('image gateway: reports the OPERATOR key as platform-paid', async () => {
    process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT = `${URL_BASE}/img`;
    let source: string | null = null;
    const out = await dispatchImageGeneration({ prompt: 'p', n: 1, onKeySource: (s) => { source = s; } });
    expect(out).toHaveLength(1);
    expect(source).toBe('platform');
  });

  it('chat widget: only the turn that OPENS a conversation carries `newSession`', async () => {
    const widget: WidgetConfig = {
      widgetId: 'w-0821', tenantId: 'user:owner', orgId: 'org-0821', agentId: 'agent-0821', allowedDomains: ['example.com'],
      caps: {}, token: 'tok-0821', enabled: true, createdBy: 'user:owner', createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
    };
    const day = new Date().toISOString().slice(0, 10);
    expect(await checkWidgetTurn(widget, 'visitor-1', day)).toEqual({ allowed: true, newSession: true });
    expect(await checkWidgetTurn(widget, 'visitor-1', day)).toEqual({ allowed: true });
  });
});
