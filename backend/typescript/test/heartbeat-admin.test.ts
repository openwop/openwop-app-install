/**
 * ADR 0318 — heartbeat admin settings. Covers (1) the core resolver honoring the
 * host-wide admin override (master kill, cadence override, per-agent precedence),
 * and (2) the service: durable resolve-for-core with the auto-disable window,
 * the read-time view, and PUT validation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  effectiveHeartbeatIntervalMs,
  HEARTBEAT_DEFAULT_MS_ENV,
  type ResolvedHeartbeatConfig,
} from '../src/host/heartbeatService.js';
import type { RosterEntry } from '../src/host/rosterService.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { getStoredConfig, getView, resolveForCore, saveConfig, validateConfig } from '../src/features/heartbeat-admin/service.js';

function entry(heartbeatIntervalMs?: number): RosterEntry {
  return {
    rosterId: 'host:x', persona: 'X', agentRef: { agentId: 'user.default.x' },
    workflows: [], tenantId: 'default', enabled: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...(heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs } : {}),
  };
}
const ON = (over: Partial<ResolvedHeartbeatConfig> = {}): ResolvedHeartbeatConfig =>
  ({ masterOff: false, hostDefaultIntervalMs: 600_000, runBudgetPerHour: null, ...over });

describe('ADR 0318 — effectiveHeartbeatIntervalMs honors the host-wide admin override', () => {
  afterEach(() => { delete process.env[HEARTBEAT_DEFAULT_MS_ENV]; });

  it('masterOff is a HARD kill — 0 even for a member with an explicit per-agent cadence', () => {
    const admin = ON({ masterOff: true, hostDefaultIntervalMs: null });
    expect(effectiveHeartbeatIntervalMs(entry(90_000), admin)).toBe(0);
    expect(effectiveHeartbeatIntervalMs(entry(), admin)).toBe(0);
  });

  it('when ON, the admin cadence overrides the env default for unconfigured members', () => {
    process.env[HEARTBEAT_DEFAULT_MS_ENV] = '0'; // env says opt-in/off…
    expect(effectiveHeartbeatIntervalMs(entry(), ON({ hostDefaultIntervalMs: 300_000 }))).toBe(300_000); // …admin override wins
  });

  it('when ON, an explicit per-agent cadence still wins over the admin default', () => {
    expect(effectiveHeartbeatIntervalMs(entry(45_000), ON({ hostDefaultIntervalMs: 600_000 }))).toBe(45_000);
  });

  it('admin absent (undefined/null) ⇒ byte-identical env behavior', () => {
    process.env[HEARTBEAT_DEFAULT_MS_ENV] = '120000';
    expect(effectiveHeartbeatIntervalMs(entry())).toBe(120_000);
    expect(effectiveHeartbeatIntervalMs(entry(), null)).toBe(120_000);
  });
});

describe('ADR 0318 — validateConfig', () => {
  it('rejects a bad status / out-of-bounds cadence / past window / negative budget', () => {
    expect(() => validateConfig({ status: 'maybe', hostDefaultIntervalMs: 600_000 })).toThrow();
    expect(() => validateConfig({ status: 'on', hostDefaultIntervalMs: 1000 })).toThrow(); // < 1 min floor
    expect(() => validateConfig({ status: 'on', hostDefaultIntervalMs: 999_999_999 })).toThrow(); // > 24h ceiling
    expect(() => validateConfig({ status: 'on', hostDefaultIntervalMs: 600_000, enabledUntil: '2000-01-01T00:00:00Z' })).toThrow();
    expect(() => validateConfig({ status: 'on', hostDefaultIntervalMs: 600_000, runBudgetPerHour: -5 })).toThrow();
  });

  it('nulls the window when status is off (no stale re-arm) and accepts a valid on+window', () => {
    const off = validateConfig({ status: 'off', hostDefaultIntervalMs: 600_000, enabledUntil: '2099-01-01T00:00:00Z' });
    expect(off.enabledUntil).toBeNull();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const on = validateConfig({ status: 'on', hostDefaultIntervalMs: 600_000, enabledUntil: future, runBudgetPerHour: 0 });
    expect(on.status).toBe('on');
    expect(on.enabledUntil).toBe(future);
    expect(on.runBudgetPerHour).toBe(0); // 0 = unlimited, preserved
  });
});

describe('ADR 0318 — service resolveForCore + getView (durable + window)', () => {
  let storage: Storage;
  beforeEach(async () => {
    storage = await openStorage('memory://');
    initHostExtPersistence(storage);
  });
  afterEach(() => { __resetHostExtPersistence(); });

  it('no saved row ⇒ null (inherit env) and getView reports not-overridden/off', async () => {
    expect(await resolveForCore()).toBeNull();
    expect(await getStoredConfig()).toBeNull();
    const view = await getView();
    expect(view.overridden).toBe(false);
    expect(view.effective.status).toBe('off');
  });

  it('status:on with no window ⇒ masterOff false + cadence override; indefinite', async () => {
    await saveConfig({ id: 'default', status: 'on', enabledUntil: null, hostDefaultIntervalMs: 300_000, runBudgetPerHour: 60 }, 'tester');
    expect(await resolveForCore()).toEqual({ masterOff: false, hostDefaultIntervalMs: 300_000, runBudgetPerHour: 60 });
    const view = await getView();
    expect(view.overridden).toBe(true);
    expect(view.effective.status).toBe('on');
    expect(view.effective.autoDisablesInMs).toBeNull(); // indefinite
  });

  it('status:on with an ELAPSED window ⇒ auto-disabled (masterOff true)', async () => {
    const past = '2020-01-01T00:00:00.000Z';
    await saveConfig({ id: 'default', status: 'on', enabledUntil: past, hostDefaultIntervalMs: 600_000, runBudgetPerHour: null }, 'tester');
    const resolved = await resolveForCore();
    expect(resolved?.masterOff).toBe(true);
    const view = await getView();
    expect(view.effective.status).toBe('off');
    expect(view.effective.autoDisabled).toBe(true);
  });

  it('status:on with a FUTURE window ⇒ on + a positive countdown', async () => {
    const now = Date.parse('2026-06-02T12:00:00Z');
    const until = new Date(now + 2 * 3_600_000).toISOString(); // +2h
    await saveConfig({ id: 'default', status: 'on', enabledUntil: until, hostDefaultIntervalMs: 600_000, runBudgetPerHour: null }, 'tester');
    expect((await resolveForCore(now))?.masterOff).toBe(false);
    const view = await getView(now);
    expect(view.effective.status).toBe('on');
    expect(view.effective.autoDisablesInMs).toBe(2 * 3_600_000);
  });

  it('status:off ⇒ masterOff true (hard kill)', async () => {
    await saveConfig({ id: 'default', status: 'off', enabledUntil: null, hostDefaultIntervalMs: 600_000, runBudgetPerHour: null }, 'tester');
    expect((await resolveForCore())?.masterOff).toBe(true);
  });
});
