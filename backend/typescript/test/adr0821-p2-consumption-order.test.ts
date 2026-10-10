/**
 * ADR 0821 D2 (corrected by architect #6) / P2 — the consumption order of a
 * managed call: free daily allowance → plan monthly allowance → purchased balance.
 *
 * Pins:
 *   A. DEFAULTS REPRODUCE TODAY (no new env): a tenant with no balance is refused
 *      at the same point with the same message; a tenant with a balance passes the
 *      cap and is drawn at the D6 weighting; the global ceiling still binds.
 *   B. G1, the ONE intended change: a call inside the free allowance draws
 *      nothing, and a call that straddles it draws only the overflow's share.
 *   C. The plan's monthly allowance pays before the balance, and once both are
 *      spent the call is refused with the existing typed error.
 *   D. The per-tenant ceiling bounds the free allowance across seats (RED witness
 *      + positive control with the env unset).
 *   E. `OPENWOP_BILLING_EXEMPT_TENANTS` is exempt from the free cap and from every
 *      draw, and the global ceiling still binds it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { resetCachedMasterKey } from '../src/byok/encryption.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  _clearManagedCacheForTests, bootstrapManagedProvider, chargeableTokens, configureManagedProvider, dispatchManagedChat, GLOBAL_USAGE_TENANT,
} from '../src/providers/managedProvider.js';
import { setManagedBalanceProvider } from '../src/host/managedBalanceHook.js';
import { registerPlanLimitsResolver } from '../src/host/planLimitsSeam.js';
import { listFeatureSpendForTenant, planAllowanceRemaining } from '../src/host/managedCredits.js';
import { managedUsageBucket } from '../src/providers/managedUsageScope.js';

let storage: Storage;
const today = () => new Date().toISOString().slice(0, 10);
const CAP = 100;

function mockMiniMaxSseOnce(inputTokens: number, outputTokens: number): void {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const body = new ReadableStream<Uint8Array>({ start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(x)); c.close(); } });
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
}

/** An in-memory balance the hook draws from, recording every draw. */
function fakeBalance(initial: number): { draws: number[]; left: () => number } {
  let bal = initial;
  const draws: number[] = [];
  setManagedBalanceProvider({
    available: async () => bal,
    draw: async (_t, n) => { const d = Math.min(n, bal); bal -= d; draws.push(d); return d; },
  });
  return { draws, left: () => bal };
}

const chat = (tenantId: string, extra: { actingSubject?: string } = {}) =>
  dispatchManagedChat({ userFacingProvider: 'openwop-free', tenantId, featureId: 'chat', messages: [{ role: 'user', content: 'hi' }], ...extra });

beforeAll(() => {
  process.env.OPENWOP_BYOK_ENCRYPTION_KEY = 'a'.repeat(64);
});

beforeEach(async () => {
  process.env.OPENWOP_MANAGED_DAILY_TOKEN_CAP = String(CAP);
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  configureManagedProvider({ storage, dataDir: '/tmp/openwop-managed-p2-test' });
  _clearManagedCacheForTests();
  resetCachedMasterKey();
  process.env.MINIMAX_API_KEY = 'sk-p2';
  await bootstrapManagedProvider();
});

afterEach(async () => {
  vi.restoreAllMocks();
  setManagedBalanceProvider(null);
  registerPlanLimitsResolver(null);
  for (const k of ['OPENWOP_MANAGED_TENANT_DAILY_TOKEN_CAP', 'OPENWOP_BILLING_EXEMPT_TENANTS', 'OPENWOP_BILLING_TOKENS_PER_CREDIT', 'OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP', 'MINIMAX_API_KEY']) delete process.env[k];
  __resetHostExtPersistence();
  await storage.close();
});

describe('A. defaults reproduce today\'s behaviour (no new env set)', () => {
  it('no balance: refused at the same point, with the same message', async () => {
    await storage.incrementManagedUsage('user:a1', 'openwop-free', today(), 60, 40);
    await expect(chat('user:a1')).rejects.toMatchObject({ code: 'daily_limit_reached', message: `Daily limit reached (${CAP} tokens). Resets at 00:00 UTC.` });
    // Positive control: one token under the cap is still served.
    await storage.incrementManagedUsage('user:a2', 'openwop-free', today(), 60, 39);
    mockMiniMaxSseOnce(5, 5);
    await expect(chat('user:a2')).resolves.toMatchObject({ completion: 'ok' });
  });

  it('a purchased balance passes the cap and is drawn in full past it', async () => {
    const bal = fakeBalance(10_000);
    await storage.incrementManagedUsage('user:a3', 'openwop-free', today(), CAP, 0);
    mockMiniMaxSseOnce(30, 20);
    await chat('user:a3');
    expect(bal.draws).toEqual([50]);
  });

  it('the global ceiling still binds a tenant with a balance', async () => {
    fakeBalance(10_000);
    process.env.OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP = '500';
    await storage.incrementManagedUsage(GLOBAL_USAGE_TENANT, 'openwop-free', today(), 500, 0);
    await expect(chat('user:a4')).rejects.toMatchObject({ code: 'daily_limit_reached' });
  });
});

describe('B. G1 — the balance is drawn only after the free allowance', () => {
  it('a call fully inside the free allowance draws nothing', async () => {
    const bal = fakeBalance(10_000);
    mockMiniMaxSseOnce(30, 20);
    await chat('user:b1');
    expect(bal.draws).toEqual([]);
    expect(bal.left()).toBe(10_000);
  });

  it('a call straddling the allowance draws only the overflow\'s share', async () => {
    const bal = fakeBalance(10_000);
    await storage.incrementManagedUsage('user:b2', 'openwop-free', today(), 80, 0); // 20 free left
    mockMiniMaxSseOnce(30, 20); // 50 raw ⇒ 30 overflow
    await chat('user:b2');
    expect(bal.draws).toEqual([30]);
    const row = (await listFeatureSpendForTenant('user:b2'))[0]!;
    expect(row.chargedTokens).toBe(30); // attribution records what was charged
  });

  it('chargeableTokens: free / straddle / fully-over, cache weighting preserved', () => {
    expect(chargeableTokens(50, 50, 100)).toBe(0);
    expect(chargeableTokens(50, 50, 20)).toBe(30);
    expect(chargeableTokens(50, 40, 0)).toBe(40);
    expect(chargeableTokens(100, 46, 50)).toBe(23); // half the raw overflows ⇒ half the weighted draw
  });
});

describe('C. the plan\'s monthly allowance pays before the balance', () => {
  it('plan first, then balance; both spent ⇒ the existing typed refusal', async () => {
    process.env.OPENWOP_BILLING_TOKENS_PER_CREDIT = '10';
    registerPlanLimitsResolver(async () => ({ aiCreditsMonthly: 6 })); // 60 token-equivalents / month
    await storage.incrementManagedUsage('user:c1', 'openwop-free', today(), CAP, 0); // free allowance spent

    // No balance: the plan alone pays.
    mockMiniMaxSseOnce(25, 15); // 40
    await chat('user:c1');
    expect(await planAllowanceRemaining('user:c1')).toBe(20);

    // Balance appears: the plan's last 20 go first, the balance takes the rest.
    const bal = fakeBalance(1_000);
    mockMiniMaxSseOnce(30, 20); // 50 ⇒ 20 plan + 30 balance
    await chat('user:c1');
    expect(await planAllowanceRemaining('user:c1')).toBe(0);
    expect(bal.draws).toEqual([30]);

    // Both spent ⇒ refused with the existing managed-cap error.
    setManagedBalanceProvider(null);
    await expect(chat('user:c1')).rejects.toMatchObject({ code: 'daily_limit_reached' });
  });

  it('no aiCreditsMonthly configured ⇒ no plan allowance (absence is zero, never unlimited)', async () => {
    registerPlanLimitsResolver(async () => ({ workflowRuns: 5 }));
    expect(await planAllowanceRemaining('user:c2')).toBe(0);
    await storage.incrementManagedUsage('user:c2', 'openwop-free', today(), CAP, 0);
    await expect(chat('user:c2')).rejects.toMatchObject({ code: 'daily_limit_reached' });
  });
});

describe('D. the per-tenant ceiling bounds the free allowance across seats (architect #6)', () => {
  const WS = 'ws:acme-0821';
  it('a second member is refused once the WORKSPACE has spent its ceiling, though their own bucket is empty', async () => {
    process.env.OPENWOP_MANAGED_TENANT_DAILY_TOKEN_CAP = '150';
    await storage.incrementManagedUsage(managedUsageBucket(WS, 'user:alice'), 'openwop-free', today(), 100, 0);
    await storage.incrementManagedUsage(managedUsageBucket(WS, 'user:bob'), 'openwop-free', today(), 50, 0);
    await expect(chat(WS, { actingSubject: 'user:carol' })).rejects.toMatchObject({
      code: 'daily_limit_reached',
      message: expect.stringContaining("workspace's daily free AI allowance"),
    });
  });

  it('positive control — env unset: the same member is served (today\'s per-subject behaviour)', async () => {
    await storage.incrementManagedUsage(managedUsageBucket(WS, 'user:alice'), 'openwop-free', today(), 100, 0);
    await storage.incrementManagedUsage(managedUsageBucket(WS, 'user:bob'), 'openwop-free', today(), 50, 0);
    mockMiniMaxSseOnce(5, 5);
    await expect(chat(WS, { actingSubject: 'user:carol' })).resolves.toMatchObject({ completion: 'ok' });
  });

  it('a workspace member past the ceiling is paid by the balance, which is drawn for the overflow', async () => {
    process.env.OPENWOP_MANAGED_TENANT_DAILY_TOKEN_CAP = '150';
    const bal = fakeBalance(1_000);
    await storage.incrementManagedUsage(managedUsageBucket(WS, 'user:alice'), 'openwop-free', today(), 140, 0); // 10 left for the ws
    mockMiniMaxSseOnce(20, 10); // 30 raw ⇒ 20 overflow
    await chat(WS, { actingSubject: 'user:dave' });
    expect(bal.draws).toEqual([20]);
  });
});

describe('E. OPENWOP_BILLING_EXEMPT_TENANTS (architect #1)', () => {
  it('an exempt tenant over the free cap with no balance is served and never drawn', async () => {
    process.env.OPENWOP_BILLING_EXEMPT_TENANTS = JSON.stringify(['conformance-prod']);
    const bal = fakeBalance(1_000);
    await storage.incrementManagedUsage('conformance-prod', 'openwop-free', today(), CAP * 10, 0);
    mockMiniMaxSseOnce(30, 20);
    await expect(chat('conformance-prod')).resolves.toMatchObject({ completion: 'ok' });
    expect(bal.draws).toEqual([]);
  });

  it('positive control — the same tenant, not listed, is refused', async () => {
    process.env.OPENWOP_BILLING_EXEMPT_TENANTS = 'conformance-verify';
    await storage.incrementManagedUsage('conformance-prod', 'openwop-free', today(), CAP * 10, 0);
    await expect(chat('conformance-prod')).rejects.toMatchObject({ code: 'daily_limit_reached' });
  });

  it('the global ceiling still binds an exempt tenant (operator backstop)', async () => {
    process.env.OPENWOP_BILLING_EXEMPT_TENANTS = 'conformance-prod';
    process.env.OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP = '500';
    await storage.incrementManagedUsage(GLOBAL_USAGE_TENANT, 'openwop-free', today(), 500, 0);
    await expect(chat('conformance-prod')).rejects.toMatchObject({ code: 'daily_limit_reached' });
  });
});
