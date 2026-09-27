/**
 * ADR 0178 — per-org BYOK LLM chat spend budget. Covers:
 *  - the storage round-trip (`incrementByokChatUsage`/`getByokChatUsage`, additive
 *    upsert, per-(tenant, provider) isolation);
 *  - `checkByokChatBudget`: off-by-default (uncapped), under/over a cap, the
 *    soft-warning threshold crossed vs. not, fail-open on no store;
 *  - `recordByokChatUsage` no-ops when both counts ≤ 0;
 *  - `resolveByokBudget` per-org override: override wins over env (incl. 0 = uncap),
 *    fail-soft to env on a resolver throw.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import {
  checkByokChatBudget,
  recordByokChatUsage,
  resolveByokBudget,
  configureByokChatBudget,
  _resetByokChatBudgetForTest,
} from '../src/aiProviders/byokChatBudget.js';
import type { Storage } from '../src/storage/storage.js';

const CAP = 'OPENWOP_BYOK_DAILY_TOKEN_CAP';
const today = new Date().toISOString().slice(0, 10);
const PROVIDER = 'anthropic';

let storage: Storage;

beforeEach(async () => {
  storage = await openStorage('memory://');
  configureByokChatBudget({ storage });
});
afterEach(() => {
  delete process.env[CAP];
  _resetByokChatBudgetForTest();
});

describe('storage byok chat usage round-trip (ADR 0178)', () => {
  it('starts at zero, accumulates additively per (tenant, provider, day)', async () => {
    expect(await storage.getByokChatUsage('org:a', PROVIDER, today)).toEqual({ inputTokens: 0, outputTokens: 0 });
    await storage.incrementByokChatUsage('org:a', PROVIDER, today, 100, 40);
    await storage.incrementByokChatUsage('org:a', PROVIDER, today, 50, 10);
    expect(await storage.getByokChatUsage('org:a', PROVIDER, today)).toEqual({ inputTokens: 150, outputTokens: 50 });
    // a different provider AND a different tenant are isolated
    expect(await storage.getByokChatUsage('org:a', 'openai', today)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(await storage.getByokChatUsage('org:b', PROVIDER, today)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('checkByokChatBudget (ADR 0178)', () => {
  it('is off by default (no env) — never exceeded/warn, cap 0', async () => {
    const v = await checkByokChatBudget('org:a', PROVIDER);
    expect(v.exceeded).toBe(false);
    expect(v.warn).toBe(false);
    expect(v.cap).toBe(0);
  });

  it('is uncapped when the cap is 0 even with heavy prior usage', async () => {
    await storage.incrementByokChatUsage('org:a', PROVIDER, today, 9_000_000, 1_000_000);
    const v = await checkByokChatBudget('org:a', PROVIDER);
    expect(v.exceeded).toBe(false);
    expect(v.warn).toBe(false);
  });

  it('reports exceeded once accumulated usage reaches the cap', async () => {
    process.env[CAP] = '1000';
    await storage.incrementByokChatUsage('org:a', PROVIDER, today, 600, 300); // 900 < 1000
    expect((await checkByokChatBudget('org:a', PROVIDER)).exceeded).toBe(false);
    await storage.incrementByokChatUsage('org:a', PROVIDER, today, 100, 0); // 1000 >= 1000
    const over = await checkByokChatBudget('org:a', PROVIDER);
    expect(over.exceeded).toBe(true);
    expect(over.used).toBe(1000);
    expect(over.cap).toBe(1000);
  });

  it('warns once the soft threshold is crossed but NOT before (default 80%)', async () => {
    process.env[CAP] = '1000';
    await storage.incrementByokChatUsage('org:a', PROVIDER, today, 790, 0); // 79% < 80%
    const below = await checkByokChatBudget('org:a', PROVIDER);
    expect(below.warn).toBe(false);
    expect(below.exceeded).toBe(false);
    expect(below.usedPct).toBe(79);

    await storage.incrementByokChatUsage('org:a', PROVIDER, today, 20, 0); // 810 => 81% >= 80%
    const warned = await checkByokChatBudget('org:a', PROVIDER);
    expect(warned.warn).toBe(true);
    expect(warned.exceeded).toBe(false);
    expect(warned.usedPct).toBe(81);
  });

  it('fails OPEN when no store is configured (a usage outage must not block a paid call)', async () => {
    process.env[CAP] = '10';
    _resetByokChatBudgetForTest(); // drop the store
    const v = await checkByokChatBudget('org:a', PROVIDER);
    expect(v.exceeded).toBe(false);
    expect(v.warn).toBe(false);
  });
});

describe('recordByokChatUsage (ADR 0178)', () => {
  it('writes real token figures', async () => {
    await recordByokChatUsage('org:a', PROVIDER, 120, 30);
    expect(await storage.getByokChatUsage('org:a', PROVIDER, today)).toEqual({ inputTokens: 120, outputTokens: 30 });
  });

  it('NO-OPs when both counts are ≤ 0', async () => {
    await recordByokChatUsage('org:a', PROVIDER, 0, 0);
    expect(await storage.getByokChatUsage('org:a', PROVIDER, today)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('resolveByokBudget — per-org override (ADR 0178)', () => {
  it('a per-org override field WINS over the env default', async () => {
    process.env[CAP] = '1000';
    configureByokChatBudget({ storage, resolveOverride: async () => ({ dailyTokenCap: 50, softWarningPct: 60 }) });
    const b = await resolveByokBudget('org:a');
    expect(b.dailyTokenCap).toBe(50); // override wins
    expect(b.softWarningPct).toBe(60);
  });

  it('an explicit override of 0 UNCAPS the org (overrides a non-zero env)', async () => {
    process.env[CAP] = '1000';
    configureByokChatBudget({ storage, resolveOverride: async () => ({ dailyTokenCap: 0 }) });
    expect((await resolveByokBudget('org:a')).dailyTokenCap).toBe(0);
    await storage.incrementByokChatUsage('org:a', PROVIDER, today, 9_999_999, 0);
    expect((await checkByokChatBudget('org:a', PROVIDER)).exceeded).toBe(false);
  });

  it('absent override softWarningPct falls back to the 80% default; cap falls to env', async () => {
    process.env[CAP] = '1000';
    configureByokChatBudget({ storage, resolveOverride: async () => ({}) });
    const b = await resolveByokBudget('org:a');
    expect(b.dailyTokenCap).toBe(1000); // env
    expect(b.softWarningPct).toBe(80);  // default
  });

  it('fails SOFT to the env default when the resolver throws', async () => {
    process.env[CAP] = '1000';
    configureByokChatBudget({ storage, resolveOverride: async () => { throw new Error('gov down'); } });
    expect((await resolveByokBudget('org:a')).dailyTokenCap).toBe(1000); // not blocked by the outage
  });
});
