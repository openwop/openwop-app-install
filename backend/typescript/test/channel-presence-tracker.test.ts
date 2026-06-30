/**
 * ADR 0126 Phase 4 / RFC 0110 — ephemeral channel-presence tracker (in-memory, never
 * persisted). present iff ≥1 live connection (multi-tab safe); typing; debounced broadcast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { joinPresence, setTyping, snapshotOf, __resetPresence } from '../src/features/channels/channelPresenceTracker.js';

beforeEach(() => { __resetPresence(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('channelPresenceTracker', () => {
  it('join marks present; snapshot lists the ref (correctness: only connected members)', () => {
    joinPresence('c1', 'user:alice', () => {});
    expect(snapshotOf('c1')).toEqual({ conversationId: 'c1', present: ['user:alice'], typing: [] });
  });

  it('present iff ≥1 connection — multi-tab safe (one leave keeps the ref present)', () => {
    const leave1 = joinPresence('c1', 'user:alice', () => {});
    const leave2 = joinPresence('c1', 'user:alice', () => {});
    leave1();
    expect(snapshotOf('c1').present).toEqual(['user:alice']); // still one connection
    leave2();
    expect(snapshotOf('c1').present).toEqual([]);             // last connection gone
  });

  it('typing is reflected (subset of present) + clears', () => {
    joinPresence('c1', 'user:alice', () => {});
    setTyping('c1', 'user:alice', true);
    expect(snapshotOf('c1').typing).toEqual(['user:alice']);
    setTyping('c1', 'user:alice', false);
    expect(snapshotOf('c1').typing).toEqual([]);
  });

  it('broadcasts a debounced snapshot to subscribers', () => {
    const a = vi.fn(); const b = vi.fn();
    joinPresence('c1', 'user:alice', a);
    joinPresence('c1', 'user:bob', b);
    vi.advanceTimersByTime(250); // past DEBOUNCE_MS
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ present: ['user:alice', 'user:bob'] }));
    expect(b).toHaveBeenCalled();
  });

  it('two channels are isolated', () => {
    joinPresence('c1', 'user:alice', () => {});
    joinPresence('c2', 'user:bob', () => {});
    expect(snapshotOf('c1').present).toEqual(['user:alice']);
    expect(snapshotOf('c2').present).toEqual(['user:bob']);
  });
});
