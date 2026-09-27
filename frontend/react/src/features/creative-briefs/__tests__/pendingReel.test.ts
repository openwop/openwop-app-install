/**
 * REEL-2 — the handle must survive a remount, and must NOT survive anything else.
 *
 * The defect being fixed: a reel poll lived in component state, and the unmount guard
 * (`if (!mountedRef.current) return; // stop silently`) abandoned a five-minute run — it
 * completed server-side and the user was never told.
 *
 * The failure mode of the FIX is the opposite one, and it is the one these cases guard:
 * a handle that outlives its run resurrects a pending placeholder that can never resolve.
 * That is the permanent-spinner defect this codebase keeps removing, re-introduced by the
 * repair. Hence the age-out and the strict validation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getPendingReel, setPendingReel, clearPendingReel } from '../pendingReel.js';

beforeEach(() => { sessionStorage.clear(); });

describe('pendingReel — survives a remount, expires otherwise', () => {
  it('round-trips for the brief that stored it', () => {
    setPendingReel('brief-1', 'run-abc');
    expect(getPendingReel('brief-1')).toMatchObject({ briefId: 'brief-1', runId: 'run-abc' });
  });

  it('is scoped to the brief — another brief must not inherit a pending reel', () => {
    setPendingReel('brief-1', 'run-abc');
    // Otherwise opening a different brief would show a placeholder for someone else's run.
    expect(getPendingReel('brief-2')).toBeNull();
  });

  it('R2 CRB-SP-12: two concurrent reels coexist — brief B does not discard brief A\'s handle', () => {
    // The store was one global slot: starting a reel on B silently dropped A's
    // handle, so A's outcome was never reported — REEL-2's own defect,
    // reintroduced for the two-concurrent case.
    setPendingReel('brief-1', 'run-a');
    setPendingReel('brief-2', 'run-b');
    expect(getPendingReel('brief-1')).toMatchObject({ runId: 'run-a' });
    expect(getPendingReel('brief-2')).toMatchObject({ runId: 'run-b' });
  });

  it('AGES OUT rather than resurrecting a placeholder that can never resolve', () => {
    // The poll caps at ~5 minutes; past double that we cannot report the outcome
    // honestly, so the handle must be dropped rather than replayed.
    sessionStorage.setItem(
      'openwop:creative-briefs:pending-reel:brief-1',
      JSON.stringify({ briefId: 'brief-1', runId: 'run-old', startedAt: Date.now() - 11 * 60 * 1000 }),
    );
    expect(getPendingReel('brief-1')).toBeNull();
    // …and it is CLEARED, not merely hidden — a stale key must not linger to be re-read.
    expect(sessionStorage.getItem('openwop:creative-briefs:pending-reel:brief-1')).toBeNull();
  });

  it('treats a malformed handle as absent instead of throwing', () => {
    sessionStorage.setItem('openwop:creative-briefs:pending-reel:brief-1', '{not json');
    expect(getPendingReel('brief-1')).toBeNull();
    sessionStorage.setItem('openwop:creative-briefs:pending-reel:brief-1', JSON.stringify({ briefId: 'brief-1' }));
    // Missing runId/startedAt: degrade to "no resume", never to a pending state with no
    // run behind it.
    expect(getPendingReel('brief-1')).toBeNull();
  });

  it('clears', () => {
    setPendingReel('brief-1', 'run-abc');
    clearPendingReel('brief-1');
    expect(getPendingReel('brief-1')).toBeNull();
  });
});
