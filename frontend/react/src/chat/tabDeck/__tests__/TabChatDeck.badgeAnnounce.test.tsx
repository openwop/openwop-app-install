/**
 * MTCU-201 / MTCU-202 — the DECK-LEVEL wiring of the background-activity
 * announcement.
 *
 * `useTabBadges` is already covered behaviourally by its own suite (rising edge,
 * baseline suppression, active-tab silence, restored-unread id advance). None of
 * that proves the DECK uses it: `onBadgeRaiseRef` is initialised to `() => {}`
 * (`TabChatDeck.tsx:151`), so deleting the assignment at `:524` leaves every hook
 * test green and the feature silently MUTE. Mechanism and wiring fail
 * independently and must be pinned separately.
 *
 * This captures the real closure the deck hands to `useTabBadges` and invokes it,
 * so the assertions run through the actual `titleFor` + i18n + politeness choice
 * rather than reading source text.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const announceSpy = vi.fn();
let captured: ((sid: string, kind: 'unread' | 'blocked') => void) | undefined;

vi.mock('../TabSession.js', () => ({
  TabSession: ({ sessionId }: { sessionId: string }) => <div data-testid="tabsession" data-sid={sessionId} />,
}));
vi.mock('../../hooks/useChatSessions.js', () => ({
  useChatSessions: () => ({
    sessions: [{ sessionId: 's-alpha', title: 'Quarterly report' }],
    isLoading: false, error: null, markRead: vi.fn(), createSession: vi.fn(),
    rename: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: null }) }));
// The deck mounts the shared reviews rail, which polls `/reviews?status=pending`.
// Left real it is a LIVE FETCH from a unit test (ADR 0661) — the guard is right:
// an unmocked call means the component takes a failure branch nobody asked for.
vi.mock('../../reviews/reviewClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../reviews/reviewClient.js')>()),
  listReviews: async () => [],
  getReview: async () => { throw new Error('not used in this test'); },
}));
vi.mock('../../../ui/announce.js', () => ({
  announce: (msg: string, opts?: { assertive?: boolean }) => announceSpy(msg, opts),
  Announcer: () => null,
}));
vi.mock('../useTabBadges.js', () => ({
  useTabBadges: (_active: string | null, _ids: string[], onRaise?: (s: string, k: 'unread' | 'blocked') => void) => {
    captured = onRaise;
    // Mirror the hook's real NO_BADGE shape — the deck reads `.blocked` off it.
    return { statusFor: () => ({ unread: false, blocked: false }), reportActivity: vi.fn() };
  },
}));

import { TabChatDeck } from '../TabChatDeck.js';

const CONFIG = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' } as never;

beforeEach(() => { localStorage.clear(); announceSpy.mockClear(); captured = undefined; });

// `onReconfigureBYOK` is REQUIRED by the deck. tsc --noEmit does not see this file
// (tsconfig.json excludes __tests__); `check-test-types` does, via tsconfig.test.json.
const onReconfigureBYOK = vi.fn();

function mount(): void {
  render(<MemoryRouter><TabChatDeck config={CONFIG} onReconfigureBYOK={onReconfigureBYOK} /></MemoryRouter>);
}

describe('TabChatDeck — the badge announcement is actually WIRED (MTCU-201)', () => {
  it('the deck hands useTabBadges a raise callback that is NOT the inert default', () => {
    mount();
    expect(captured, 'the deck must pass a raise callback at all').toBeTypeOf('function');
    captured!('s-alpha', 'unread');
    expect(announceSpy, 'the callback must reach announce() — an inert default announces nothing').toHaveBeenCalledTimes(1);
  });

  it('an unread raise announces POLITELY and NAMES the tab (MTCU-202)', () => {
    mount();
    captured!('s-alpha', 'unread');
    const [msg, opts] = announceSpy.mock.calls[0] as [string, { assertive?: boolean } | undefined];
    expect(msg, 'the tab name is the whole point — the announcement is out of context').toContain('Quarterly report');
    expect(msg).toBe('New reply in Quarterly report');
    expect(opts?.assertive, 'a background reply is ambient, not an interrupt').toBeFalsy();
  });

  it('a blocked raise announces ASSERTIVELY and names the tab (a HITL wait blocks the user)', () => {
    mount();
    captured!('s-alpha', 'blocked');
    const [msg, opts] = announceSpy.mock.calls[0] as [string, { assertive?: boolean } | undefined];
    expect(msg).toBe('Quarterly report needs your input');
    expect(opts?.assertive).toBe(true);
  });

  it('an unknown session still announces with a usable fallback name, never "undefined"', () => {
    mount();
    captured!('s-ghost', 'unread');
    const [msg] = announceSpy.mock.calls[0] as [string];
    expect(msg).not.toContain('undefined');
    expect(msg.length, 'a fallback title must be non-empty').toBeGreaterThan('New reply in '.length);
  });
});
