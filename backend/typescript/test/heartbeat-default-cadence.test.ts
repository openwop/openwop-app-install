/**
 * ADR 0313 P1 — heartbeat default-on: `effectiveHeartbeatIntervalMs` is the
 * ONE cadence resolver (due check + fleet slot quantization). `0`/absent =
 * "not configured" → the host default applies (the ADR correction: stored 0s
 * are form noise, not opt-outs); explicit `-1` = deliberately OFF; the host
 * default itself is env-tunable and `0` restores the pre-0313 opt-in world.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { effectiveHeartbeatIntervalMs, HEARTBEAT_DEFAULT_MS_ENV, HEARTBEAT_OFF } from '../src/host/heartbeatService.js';
import type { RosterEntry } from '../src/host/rosterService.js';

function entry(heartbeatIntervalMs?: number): RosterEntry {
  return {
    rosterId: 'host:x', persona: 'X', agentRef: { agentId: 'user.default.x' },
    workflows: [], tenantId: 'default', enabled: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...(heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs } : {}),
  };
}

afterEach(() => { delete process.env[HEARTBEAT_DEFAULT_MS_ENV]; });

describe('ADR 0313 D1 — effectiveHeartbeatIntervalMs', () => {
  it('an explicit positive cadence wins', () => {
    expect(effectiveHeartbeatIntervalMs(entry(90_000))).toBe(90_000);
  });

  it('absent AND stored-0 both fall back to the host default (10 min)', () => {
    expect(effectiveHeartbeatIntervalMs(entry())).toBe(600_000);
    expect(effectiveHeartbeatIntervalMs(entry(0))).toBe(600_000); // the form-noise correction
  });

  it('explicit -1 is deliberately OFF', () => {
    expect(effectiveHeartbeatIntervalMs(entry(HEARTBEAT_OFF))).toBe(0);
  });

  it('the host default is env-tunable; 0 restores the opt-in world', () => {
    process.env[HEARTBEAT_DEFAULT_MS_ENV] = '120000';
    expect(effectiveHeartbeatIntervalMs(entry())).toBe(120_000);
    process.env[HEARTBEAT_DEFAULT_MS_ENV] = '0';
    expect(effectiveHeartbeatIntervalMs(entry())).toBe(0);
    expect(effectiveHeartbeatIntervalMs(entry(45_000))).toBe(45_000); // explicit still wins
  });
});
