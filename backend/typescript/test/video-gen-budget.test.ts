/**
 * ADR 0411 P1 — the `video` unit on the ADR 0106 media budget. The unit itself
 * predates this ADR (ADR 0404 scaffolding) but was untested; `callVideoGenerator`
 * pre-flights `checkMediaBudget(tenantId,'video',1)` and maps `exceeded` →
 * `provider_rate_limited`, so pin the unit's contract: env cap, 0 = uncapped,
 * KV-backed daily count, per-org override, and the fail-closed CAS behavior —
 * mirroring image-gen-budget.test.ts.
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
afterEach(() => { delete process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS; _resetMediaBudgetForTest(); });

describe('video unit on the media budget (ADR 0411 P1)', () => {
  it('defaults to 0 = uncapped/off (video is opt-in; the ADR warns operators to set a cap)', () => {
    expect(mediaDailyBudget().video).toBe(0);
  });

  it('tracks used + remaining, denies at the cap (the provider_rate_limited pre-flight input)', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '2';
    const t = `t-vid-${Date.now()}`;
    expect(await checkMediaBudget(t, 'video', 1)).toMatchObject({ exceeded: false, used: 0, remaining: 2 });
    await recordMediaUsage(t, 'video', 1);
    expect(await checkMediaBudget(t, 'video', 1)).toMatchObject({ exceeded: false, used: 1, remaining: 1 });
    await recordMediaUsage(t, 'video', 1);
    expect((await checkMediaBudget(t, 'video', 1)).exceeded).toBe(true); // 2/2 → callVideoGenerator throws provider_rate_limited
  });

  it('cap 0 is uncapped and records nothing', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '0';
    const t = `t-vid0-${Date.now()}`;
    await recordMediaUsage(t, 'video', 25);
    expect((await checkMediaBudget(t, 'video', 1)).exceeded).toBe(false);
  });

  it('the per-org governance override wins over env, field by field (incl. explicit 0)', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '1';
    const t = `t-vidov-${Date.now()}`;
    configureMediaBudget({ storage, resolveOverride: async () => ({ videoJobs: 4 }) });
    await recordMediaUsage(t, 'video', 2);
    expect(await checkMediaBudget(t, 'video', 1)).toMatchObject({ exceeded: false, used: 2, cap: 4 });
    configureMediaBudget({ storage, resolveOverride: async () => ({ videoJobs: 0 }) });
    expect((await checkMediaBudget(t, 'video', 1)).exceeded).toBe(false); // 0 = uncapped for this org
  });

  it('parallel records never lose increments (the CAS contract)', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '100';
    const t = `t-vidcas-${Date.now()}`;
    await Promise.all(Array.from({ length: 8 }, () => recordMediaUsage(t, 'video', 1)));
    expect((await checkMediaBudget(t, 'video', 1)).used).toBe(8);
  });
});
