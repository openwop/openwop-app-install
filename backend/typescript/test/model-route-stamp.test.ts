/**
 * ADR 0130 Phase 3c — computeRouteStamp (the lazy-stamp decision: the replay guard
 * + the stamp shape). The persistence wrapper (maybeStampModelRoute) layers
 * storage.updateRun + resolveModelRoute (both separately tested) over this.
 */
import { describe, it, expect } from 'vitest';
import { computeRouteStamp } from '../src/host/conversationExchange.js';

describe('computeRouteStamp', () => {
  it('stamps modelRoute into fresh metadata when a target is routed', () => {
    const out = computeRouteStamp({ chatSessionId: 'c1' }, { provider: 'anthropic', model: 'big' });
    expect(out).toEqual({ chatSessionId: 'c1', modelRoute: { provider: 'anthropic', model: 'big' } });
  });

  it('REPLAY GUARD: returns null when already stamped (never re-resolve on fork)', () => {
    const existing = { modelRoute: { provider: 'openai', model: 'small' } };
    expect(computeRouteStamp(existing, { provider: 'anthropic', model: 'big' })).toBeNull();
  });

  it('returns null when no target is routed (router off → keep the explicit model)', () => {
    expect(computeRouteStamp({ chatSessionId: 'c1' }, null)).toBeNull();
  });

  it('preserves other metadata keys when stamping', () => {
    const out = computeRouteStamp({ actingUserId: 'u1', chatSessionId: 'c1' }, { provider: 'p', model: 'm' });
    expect(out).toMatchObject({ actingUserId: 'u1', chatSessionId: 'c1' });
  });
});
