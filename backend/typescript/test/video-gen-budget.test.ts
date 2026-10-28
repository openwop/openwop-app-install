/**
 * ADR 0411 P1 — the `video` unit on the ADR 0106 media budget. The unit itself
 * predates this ADR (ADR 0404 scaffolding) but was untested; `callVideoGenerator`
 * pre-flights `checkMediaBudget(tenantId,'video',1)` and maps `exceeded` →
 * `provider_rate_limited`, so pin the unit's contract: env cap, 0 = uncapped,
 * KV-backed daily count, per-org override, the CAS increment, and the
 * FAIL-CLOSED read (ADR 0404 grade-code CV-4: video is the costliest kind, so a
 * usage-read outage refuses instead of waving renders through) — mirroring
 * image-gen-budget.test.ts.
 *
 * Determinism: the counter is keyed on the UTC day, so `Date` is faked to a fixed
 * instant per case (a run straddling midnight would otherwise split one tenant's
 * count across two days). Sabotage: 8fw4g1-vb-env / -vb-default / -vb-cas /
 * -vb-override (round 1), 8fw4g1-vb-uncapped-r2 and 8fw4g1-vb-failclosed-r2.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { checkMediaBudget, recordMediaUsage, mediaDailyBudget, configureMediaBudget, _resetMediaBudgetForTest } from '../src/aiProviders/mediaBudget.js';
import type { Storage } from '../src/storage/storage.js';

let storage: Storage;
let n = 0;
/** A tenant id of its own per case (no shared counter between cases or shuffles). */
const tenant = (tag: string): string => `t-vid-${tag}-${n++}`;

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS;
  _resetMediaBudgetForTest();
});

describe('video unit on the media budget (ADR 0411 P1)', () => {
  it('defaults to 0 = uncapped/off (video is opt-in; the ADR warns operators to set a cap)', async () => {
    // Twin of media-budget.test.ts:66 for the CONSTANT; this case adds what the default
    // DOES: with no env set, a video pre-flight is the uncapped answer.
    expect(mediaDailyBudget().video).toBe(0);
    expect(await checkMediaBudget(tenant('default'), 'video', 1)).toMatchObject({ exceeded: false, cap: 0, remaining: Infinity });
  });

  it('tracks used + remaining, denies at the cap (the provider_rate_limited pre-flight input)', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '2';
    const t = tenant('cap');
    expect(await checkMediaBudget(t, 'video', 1)).toMatchObject({ exceeded: false, used: 0, remaining: 2 });
    await recordMediaUsage(t, 'video', 1);
    expect(await checkMediaBudget(t, 'video', 1)).toMatchObject({ exceeded: false, used: 1, remaining: 1 });
    await recordMediaUsage(t, 'video', 1);
    expect((await checkMediaBudget(t, 'video', 1)).exceeded).toBe(true); // 2/2 → callVideoGenerator throws provider_rate_limited
  });

  it('cap 0 is uncapped and records nothing', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '0';
    const t = tenant('zero');
    await recordMediaUsage(t, 'video', 25);
    expect((await checkMediaBudget(t, 'video', 1)).exceeded).toBe(false);
    // "records nothing": at cap 0 the check returns before reading any count, so the
    // proof is to turn a cap ON afterwards and read what was stored (round-1 probe
    // 8fw4g1-vb-uncapped stayed green without this).
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '30';
    expect(await checkMediaBudget(t, 'video', 1)).toMatchObject({ used: 0, cap: 30 });
  });

  it('the per-org governance override wins over env, field by field (incl. explicit 0)', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '1';
    const t = tenant('ov');
    configureMediaBudget({ storage, resolveOverride: async () => ({ videoJobs: 4 }) });
    await recordMediaUsage(t, 'video', 2);
    expect(await checkMediaBudget(t, 'video', 1)).toMatchObject({ exceeded: false, used: 2, cap: 4 });
    configureMediaBudget({ storage, resolveOverride: async () => ({ videoJobs: 0 }) });
    expect((await checkMediaBudget(t, 'video', 1)).exceeded).toBe(false); // 0 = uncapped for this org
  });

  it('parallel records never lose increments (the CAS contract)', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '100';
    const t = tenant('cas');
    // Witnessed in round 1 (8fw4g1-vb-cas): the 8 writers DO interleave on the
    // in-memory store, so a blind write loses increments here.
    await Promise.all(Array.from({ length: 8 }, () => recordMediaUsage(t, 'video', 1)));
    expect((await checkMediaBudget(t, 'video', 1)).used).toBe(8);
  });

  it('CV-4 — a usage-read OUTAGE fails CLOSED for video (exceeded, nothing remaining)', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '5';
    const t = tenant('outage');
    const realGet = DurableCollection.prototype.get;
    let failedReads = 0;
    vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(function (this: DurableCollection<unknown>, id: string) {
      if (id.startsWith(`${t}:`)) { failedReads++; return Promise.reject(new Error('kv unavailable')); }
      return realGet.call(this, id);
    });
    expect(await checkMediaBudget(t, 'video', 1)).toMatchObject({ exceeded: true, cap: 5, used: 5, remaining: 0 });
    expect(failedReads, 'the outage was on the video counter read itself').toBe(1);
  });
});
