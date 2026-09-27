/**
 * ADR 0717 — the heartbeat emergency brake must survive a config-store fault.
 *
 * ADR 0318 deliberately fails OPEN on a provider error so a store hiccup cannot wedge
 * the loop. `masterOff` — the operator's kill switch — rode in the same object, so the
 * SAFETY control was discarded alongside the availability ones.
 *
 * The measured facts that set the severity (all re-checked in leg 0):
 *   - `OPENWOP_HEARTBEAT_DEFAULT_MS` is set NOWHERE in deploy config, so the fallback
 *     applies and the host default is 600_000 ms — TEN MINUTES, not 0;
 *   - roster entries default to `enabled: true` and the daemon starts unconditionally.
 * So the tracker's "safe only while the env is pinned to 0" described a pin nobody
 * applied — and so did this ADR's own first draft. Both were corrected on measurement.
 *
 * The two legs that matter most (3 and 4) are the ones an INTUITIVE fix fails: caching
 * the resolved `masterOff` boolean instead of the settings pins a time-derived decision
 * and silently disables the auto-disable window in one direction while making the fleet
 * unrevivable in the other.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  resolveForCore, saveConfig, defaultConfig, __resetHeartbeatConfigCacheForTests,
} from '../src/features/heartbeat-admin/service.js';
import type { HeartbeatAdminConfig } from '../src/features/heartbeat-admin/types.js';
import { effectiveHeartbeatIntervalMs } from '../src/host/heartbeatService.js';
import type { RosterEntry } from '../src/host/rosterService.js';

const T0 = Date.parse('2026-09-17T12:00:00.000Z');
const agent = (ms?: number): RosterEntry => ({
  tenantId: 't', rosterId: 'r1', agentId: 'a1', name: 'A', enabled: true,
  ...(ms !== undefined ? { heartbeatIntervalMs: ms } : {}),
} as unknown as RosterEntry);

/** Make the NEXT store read throw, simulating a durable-store hiccup. */
function breakTheStore(): () => void {
  const spy = vi.spyOn(DurableCollection.prototype, 'get').mockRejectedValue(new Error('store down'));
  return () => spy.mockRestore();
}

const cfg = (over: Partial<HeartbeatAdminConfig>): HeartbeatAdminConfig => ({ ...defaultConfig(), ...over });

beforeEach(async () => {
  __resetHeartbeatConfigCacheForTests();
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ADR 0717 — the brake survives a store fault', () => {
  it('leg 0 (the severity premise): the host default is TEN MINUTES, not 0, when the env is unset', () => {
    // If this ever becomes 0, the tracker's original "safe only while env=0" framing
    // would finally be true and this ADR's severity paragraph must be revisited.
    delete process.env.OPENWOP_HEARTBEAT_DEFAULT_MS;
    expect(effectiveHeartbeatIntervalMs(agent(), null)).toBe(600_000);
  });

  it('leg 1: an explicit status:off brake is PRESERVED across a provider fault', async () => {
    await saveConfig(cfg({ status: 'off' }), 'op');
    expect((await resolveForCore(T0))?.masterOff, 'healthy read: brake on').toBe(true);
    const restore = breakTheStore();
    try {
      const degraded = await resolveForCore(T0);
      expect(degraded?.masterOff, 'a store hiccup must NOT release the brake').toBe(true);
      // And it must actually stop a per-agent-cadence member — the case the env pin
      // never covered, because `configured > 0` returns before the env is consulted.
      expect(effectiveHeartbeatIntervalMs(agent(60_000), degraded)).toBe(0);
    } finally { restore(); }
  });

  it('leg 2 (CONTROL): with the brake OFF, a fault still inherits the env — ADR 0318 availability kept', async () => {
    // Without this, a fix that simply returned masterOff:true on every fault would pass
    // leg 1 while handing any storage hiccup a fleet-wide kill.
    await saveConfig(cfg({ status: 'on', hostDefaultIntervalMs: 30_000 }), 'op');
    expect((await resolveForCore(T0))?.masterOff).toBe(false);
    const restore = breakTheStore();
    try {
      const degraded = await resolveForCore(T0);
      expect(degraded?.masterOff, 'a hiccup must not invent a brake').toBe(false);
      expect(degraded?.hostDefaultIntervalMs, 'cadence override dropped → env inherited').toBeNull();
    } finally { restore(); }
  });

  it('leg 3: a window that elapses DURING the fault still brakes (the time-derived half)', async () => {
    // THE leg that a cached `masterOff` boolean fails: at T0 the window is open, so a
    // cached boolean would say masterOff:false forever and the auto-disable would never
    // fire. Re-deriving at `now` gets it right.
    await saveConfig(cfg({ status: 'on', enabledUntil: new Date(T0 + 60_000).toISOString() }), 'op');
    expect((await resolveForCore(T0))?.masterOff, 'inside the window: running').toBe(false);
    const restore = breakTheStore();
    try {
      const after = await resolveForCore(T0 + 120_000); // window has now elapsed
      expect(after?.masterOff, 'the auto-disable window must still fire during a fault').toBe(true);
    } finally { restore(); }
  });

  it('leg 4: a re-opened window is honoured during a fault (the other direction)', async () => {
    // The mirror of leg 3: a cached `masterOff:true` would make the fleet unrevivable.
    await saveConfig(cfg({ status: 'on', enabledUntil: new Date(T0 - 1).toISOString() }), 'op');
    expect((await resolveForCore(T0))?.masterOff, 'elapsed: braked').toBe(true);
    await saveConfig(cfg({ status: 'on', enabledUntil: new Date(T0 + 600_000).toISOString() }), 'op');
    await resolveForCore(T0); // cache the re-opened settings
    const restore = breakTheStore();
    try {
      expect((await resolveForCore(T0))?.masterOff, 'a fault must not pin a stale brake').toBe(false);
    } finally { restore(); }
  });

  it('leg 5: a TIGHTENED run budget survives the fault; it does not spring back to the env cap', async () => {
    // runBudgetPerHour is a SAFETY bound (env default 120/h). Dropping a 5/h cap on a
    // fault would be a 24x loosening — the same "a stated bound evaporates" class.
    await saveConfig(cfg({ status: 'on', runBudgetPerHour: 5 }), 'op');
    expect((await resolveForCore(T0))?.runBudgetPerHour).toBe(5);
    const restore = breakTheStore();
    try {
      expect((await resolveForCore(T0))?.runBudgetPerHour, 'the tighter cap wins').toBe(5);
    } finally { restore(); }
  });

  it('leg 6: an UNLIMITED cached budget loses to the env default on a fault', async () => {
    // `<= 0` means unlimited, so "tighter" is not a naive Math.min — this is the leg
    // that catches that mistake.
    await saveConfig(cfg({ status: 'on', runBudgetPerHour: 0 }), 'op');
    expect((await resolveForCore(T0))?.runBudgetPerHour, 'healthy: unlimited as saved').toBe(0);
    const restore = breakTheStore();
    try {
      expect((await resolveForCore(T0))?.runBudgetPerHour, 'unlimited must not survive a fault').toBeNull();
    } finally { restore(); }
  });

  it('leg 7: with NO last-known-good, a fault is unchanged — it never invents a brake', async () => {
    const restore = breakTheStore();
    try {
      await expect(resolveForCore(T0), 'rethrow → the core seam catches → env default').rejects.toThrow();
    } finally { restore(); }
  });

  it('leg 8 (equivalence): {masterOff:false, nulls} behaves exactly like admin === null', async () => {
    delete process.env.OPENWOP_HEARTBEAT_DEFAULT_MS;
    const asNull = effectiveHeartbeatIntervalMs(agent(), null);
    const asBenign = effectiveHeartbeatIntervalMs(agent(), { masterOff: false, hostDefaultIntervalMs: null, runBudgetPerHour: null });
    expect(asBenign).toBe(asNull);
  });
});
