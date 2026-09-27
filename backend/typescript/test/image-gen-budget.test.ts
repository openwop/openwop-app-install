/**
 * ADR 0115 Phase 5 → ADR 0401 P4 — image spend governance, converged onto the
 * ADR 0106 media budget (`kind:'images'`). Same behavior contract as the
 * retired `host/imageGenBudget.ts`: default 50/day via
 * `OPENWOP_IMAGE_MAX_PER_DAY`, 0 ⇒ uncapped, KV-backed daily count, per-org
 * governance override (incl. explicit 0 = uncapped) through the same resolver
 * as tts/stt.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { checkMediaBudget, recordMediaUsage, mediaDailyBudget, configureMediaBudget, _resetMediaBudgetForTest } from '../src/aiProviders/mediaBudget.js';
import type { Storage } from '../src/storage/storage.js';

let storage: Storage;
beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
afterEach(() => { delete process.env.OPENWOP_IMAGE_MAX_PER_DAY; _resetMediaBudgetForTest(); });

describe('images unit on the media budget (ADR 0401 P4)', () => {
  it('defaults to 50/day (the carried-over ADR 0115 posture)', () => {
    expect(mediaDailyBudget().images).toBe(50);
  });

  it('tracks used + remaining, denies at the cap', async () => {
    process.env.OPENWOP_IMAGE_MAX_PER_DAY = '3';
    const t = `t-img-${Date.now()}`;
    expect(await checkMediaBudget(t, 'images', 1)).toMatchObject({ exceeded: false, used: 0, remaining: 3 });
    await recordMediaUsage(t, 'images', 2);
    expect(await checkMediaBudget(t, 'images', 1)).toMatchObject({ exceeded: false, used: 2, remaining: 1 });
    await recordMediaUsage(t, 'images', 1);
    expect((await checkMediaBudget(t, 'images', 1)).exceeded).toBe(true); // 3/3
  });

  it('cap 0 is uncapped and records nothing', async () => {
    process.env.OPENWOP_IMAGE_MAX_PER_DAY = '0';
    const t = `t-img0-${Date.now()}`;
    await recordMediaUsage(t, 'images', 100);
    expect((await checkMediaBudget(t, 'images', 1)).exceeded).toBe(false);
  });

  it('the per-org governance override wins over env, field by field (incl. explicit 0)', async () => {
    process.env.OPENWOP_IMAGE_MAX_PER_DAY = '2';
    const t = `t-imgov-${Date.now()}`;
    configureMediaBudget({ storage, resolveOverride: async () => ({ images: 5 }) });
    await recordMediaUsage(t, 'images', 3);
    expect(await checkMediaBudget(t, 'images', 1)).toMatchObject({ exceeded: false, used: 3, cap: 5 });
    configureMediaBudget({ storage, resolveOverride: async () => ({ images: 0 }) });
    expect((await checkMediaBudget(t, 'images', 1)).exceeded).toBe(false); // 0 = uncapped for this org
    configureMediaBudget({ storage, resolveOverride: async () => ({ ttsChars: 10 }) });
    expect((await checkMediaBudget(t, 'images', 1)).cap).toBe(2); // absent field falls to env
  });

  it('parallel records never lose increments (the CAS contract)', async () => {
    process.env.OPENWOP_IMAGE_MAX_PER_DAY = '100';
    const t = `t-imgcas-${Date.now()}`;
    await Promise.all(Array.from({ length: 8 }, () => recordMediaUsage(t, 'images', 1)));
    expect((await checkMediaBudget(t, 'images', 1)).used).toBe(8);
  });
});
