/**
 * ADR 0785 D5 — non-conversation tab kinds in the chat deck.
 *
 * The deck is core and a kind comes from an excludable feature, so these pin the
 * seam rather than any one feature: a kind survives a reload, a malformed kind
 * does not, an old deck (no kind) restores unchanged, and the new-tab control
 * becomes a menu only when a kind is on offer.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { tabDeckReducer, emptyTabDeck } from '../tabDeckModel.js';
import { sanitizeTabDeck } from '../tabDeckPersistence.js';
import { LS_TABDECK_VERSION } from '../../lib/storageKeys.js';
import { TabStrip } from '../TabStrip.js';
import { registerDeckTabKind, getDeckTabKind, __clearDeckTabKindsForTest } from '../tabKindRegistry.js';

afterEach(() => { cleanup(); __clearDeckTabKindsForTest(); });

describe('deck tab kinds', () => {
  it('open carries the kind onto the tab', () => {
    const s = tabDeckReducer(emptyTabDeck, { type: 'open', sessionId: 'claude-code-1', kind: 'claude-code' });
    expect(s.tabs[0]).toMatchObject({ sessionId: 'claude-code-1', kind: 'claude-code' });
    const plain = tabDeckReducer(s, { type: 'open', sessionId: 'conv-1' });
    expect(plain.tabs[1]!.kind).toBeUndefined();
  });

  it('persistence keeps a valid kind, drops a malformed one, and restores an old deck unchanged', () => {
    const env = (tabs: unknown[]) => ({ v: LS_TABDECK_VERSION, subject: 'u1', state: { tabs, activeSessionId: null, seq: 3 } });
    const kept = sanitizeTabDeck(env([{ sessionId: 'a', pinned: false, lastActiveSeq: 1, kind: 'claude-code' }]), 'u1');
    expect(kept?.tabs[0]?.kind).toBe('claude-code');
    const bad = sanitizeTabDeck(env([{ sessionId: 'b', pinned: false, lastActiveSeq: 1, kind: '<script>' }]), 'u1');
    expect(bad?.tabs).toEqual([]);
    const old = sanitizeTabDeck(env([{ sessionId: 'c', pinned: false, lastActiveSeq: 1 }]), 'u1');
    expect(old?.tabs[0]).toEqual({ sessionId: 'c', pinned: false, lastActiveSeq: 1 });
  });

  it('the registry refuses a malformed kind id', () => {
    expect(() => registerDeckTabKind({ kind: 'Bad Kind', label: () => 'x', featureId: 'x', Component: () => null })).toThrow();
    registerDeckTabKind({ kind: 'claude-code', label: () => 'Claude Code', featureId: 'claude-code', Component: () => null });
    expect(getDeckTabKind('claude-code')?.featureId).toBe('claude-code');
    expect(getDeckTabKind(undefined)).toBeUndefined();
  });

  const baseProps = {
    tabs: [], activeSessionId: null, titleFor: () => 'x',
    onFocus: vi.fn(), onClose: vi.fn(), onReorder: vi.fn(), onSetPinned: vi.fn(),
  };

  it('no kinds on offer ⇒ the plain new-chat button (unchanged behaviour)', () => {
    const onNewTab = vi.fn();
    render(<TabStrip {...baseProps} onNewTab={onNewTab} />);
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }));
    expect(onNewTab).toHaveBeenCalledTimes(1);
  });

  it('a kind on offer ⇒ a menu: new chat first, then the kind', () => {
    const onNewTab = vi.fn(); const onKind = vi.fn();
    render(<TabStrip {...baseProps} onNewTab={onNewTab} newTabKinds={[{ kind: 'claude-code', label: 'Claude Code' }]} onNewTabOfKind={onKind} />);
    fireEvent.click(screen.getByRole('button', { name: /new tab/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Code' }));
    expect(onKind).toHaveBeenCalledWith('claude-code');
    expect(onNewTab).not.toHaveBeenCalled();
  });
});
