import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { computeTabBadge, deriveActivity, useTabBadges, NO_BADGE } from '../useTabBadges.js';
import type { ChatMessage } from '../../types.js';

const msg = (id: string, role: ChatMessage['role'], extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role, content: '', createdAt: '2026-01-01T00:00:00Z', ...extra });

describe('deriveActivity (pure) — the finalized-inbound projection', () => {
  it('excludes the in-flight streaming bubble while sending (badge on completion, not start)', () => {
    const msgs = [msg('u1', 'user'), msg('a1', 'assistant'), msg('a2', 'assistant')];
    // a2 is the trailing in-flight bubble while sending → lastInbound stays a1.
    expect(deriveActivity(msgs, true).lastInboundId).toBe('a1');
    // Once the turn finalizes (isSending false), lastInbound advances to a2.
    expect(deriveActivity(msgs, false).lastInboundId).toBe('a2');
  });

  it('ignores user + system messages for inbound', () => {
    const msgs = [msg('s0', 'system'), msg('u1', 'user')];
    expect(deriveActivity(msgs, false).lastInboundId).toBeNull();
  });

  it('flags blocked when any message has an open interrupt', () => {
    const open = [{ nodeId: 'n', kind: 'approval' }] as unknown as ChatMessage['activeInterrupts'];
    const msgs = [msg('w1', 'workflow_run', { activeInterrupts: open })];
    expect(deriveActivity(msgs, false).blocked).toBe(true);
    expect(deriveActivity([msg('a1', 'assistant')], false).blocked).toBe(false);
  });
});

describe('computeTabBadge (pure)', () => {
  it('the active tab never badges', () => {
    expect(computeTabBadge(true, 'm2', 'm1', true)).toEqual(NO_BADGE);
  });
  it('blocked outranks unread', () => {
    expect(computeTabBadge(false, 'm2', 'm1', true)).toEqual({ unread: false, blocked: true });
  });
  it('unread when the last inbound id differs from seen', () => {
    expect(computeTabBadge(false, 'm2', 'm1', false)).toEqual({ unread: true, blocked: false });
    expect(computeTabBadge(false, 'm1', 'm1', false)).toEqual(NO_BADGE); // seen
    expect(computeTabBadge(false, null, null, false)).toEqual(NO_BADGE); // nothing inbound
  });
});

describe('useTabBadges (state machine)', () => {
  it('a reply in a BACKGROUND tab shows unread; focusing it clears', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useTabBadges(active, ['a', 'b']),
      { initialProps: { active: 'a' as string | null } },
    );
    // A reply lands in background tab 'b'.
    act(() => { result.current.reportActivity('b', 'b-msg1', false); });
    expect(result.current.statusFor('b')).toEqual({ unread: true, blocked: false });
    expect(result.current.statusFor('a')).toEqual(NO_BADGE);

    // Focus 'b' → cleared.
    rerender({ active: 'b' });
    expect(result.current.statusFor('b')).toEqual(NO_BADGE);
  });

  it('a self-reply in the ACTIVE tab never badges', () => {
    const { result } = renderHook(() => useTabBadges('a', ['a', 'b']));
    act(() => { result.current.reportActivity('a', 'a-msg1', false); });
    expect(result.current.statusFor('a')).toEqual(NO_BADGE);
  });

  it('a blocked background tab shows blocked; it survives switching away', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useTabBadges(active, ['a', 'b']),
      { initialProps: { active: 'a' as string | null } },
    );
    act(() => { result.current.reportActivity('b', 'b-1', true); });
    expect(result.current.statusFor('b')).toEqual({ unread: false, blocked: true });
    // Switch to b (clears), then away to a — b stays blocked (its interrupt is unresolved).
    rerender({ active: 'b' });
    expect(result.current.statusFor('b')).toEqual(NO_BADGE);
    act(() => { result.current.reportActivity('b', 'b-1', true); }); // still blocked while active → no badge
    rerender({ active: 'a' });
    expect(result.current.statusFor('b')).toEqual({ unread: false, blocked: true });
  });

  it('reportActivity is referentially STABLE across renders (so it does not defeat TabSession memo)', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useTabBadges(active, ['a', 'b']),
      { initialProps: { active: 'a' as string | null } },
    );
    const first = result.current.reportActivity;
    act(() => { result.current.reportActivity('b', 'b-1', false); }); // state change
    rerender({ active: 'b' }); // active change
    expect(result.current.reportActivity).toBe(first); // same identity → memo intact
  });

  it('prunes a closed tab and resets a reused id', () => {
    const { result, rerender } = renderHook(
      ({ open }) => useTabBadges('a', open),
      { initialProps: { open: ['a', 'b'] as string[] } },
    );
    act(() => { result.current.reportActivity('b', 'b-1', false); });
    expect(result.current.statusFor('b').unread).toBe(true);
    // Close 'b'.
    rerender({ open: ['a'] });
    expect(result.current.statusFor('b')).toEqual(NO_BADGE);
    // Reopen 'b' — clean slate (no stale unread until a NEW reply lands).
    rerender({ open: ['a', 'b'] });
    expect(result.current.statusFor('b')).toEqual(NO_BADGE);
  });
});
