/**
 * MTCU-201 / MTCU-202 — the DECK-LEVEL wiring of the background-activity
 * announcement.
 *
 * `useTabBadges` is already covered behaviourally by its own suite (rising edge,
 * baseline suppression, active-tab silence, restored-unread id advance). None of
 * that proves the DECK uses it: `onBadgeRaiseRef` is initialised to `() => {}`
 * (in TabChatDeck), so deleting its assignment (the `onBadgeRaiseRef.current = …`
 * block just before `evictHandlerRef`) leaves every hook
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
import type { UseChatSessionsResult } from '../../hooks/useChatSessions.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';

const announceSpy = vi.fn();
let captured: ((sid: string, kind: 'unread' | 'blocked') => void) | undefined;

// ADR 0978 D4 — the deck resolves the active workspace before it restores.
vi.mock('../../../client/workspaceClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/workspaceClient.js')>()),
  listMyWorkspaces: async () => ({ workspaces: [], active: 'ws-test', personal: 'ws-test' }),
}));
vi.mock('../TabSession.js', () => ({
  TabSession: ({ sessionId }: { sessionId: string }) => <div data-testid="tabsession" data-sid={sessionId} />,
}));
vi.mock('../../hooks/useChatSessions.js', () => ({
  useChatSessions: () => sessionsStub({ sessions: [row({ sessionId: 's-alpha', title: 'Quarterly report' })] }),
}));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: null }) }));
// ADR 0776 P2 — the rail's server read; not what this test is about.
vi.mock('../../conversations/useRunningConversations.js', () => ({ useRunningConversations: () => new Set() }));
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
}));
vi.mock('../useTabBadges.js', () => ({
  useTabBadges: (_active: string | null, _ids: string[], onRaise?: (s: string, k: 'unread' | 'blocked') => void) => {
    captured = onRaise;
    // Mirror the hook's real NO_BADGE shape — the deck reads `.blocked` off it.
    return { statusFor: () => ({ unread: false, blocked: false }), reportActivity: vi.fn() };
  },
}));

import { TabChatDeck } from '../TabChatDeck.js';

// Typed stand-ins for the deck's server reads (X4/X3): every UseChatSessionsResult
// member, production-shaped rows, and the two other server reads the deck makes
// (the reviews inbox poll and the running-conversations poll) — never live (ADR 0661).
const row = (o: Partial<ChatSessionHeader> & { sessionId: string }): ChatSessionHeader => ({
  tenantId: 't1', title: 'New chat', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 1, ...o,
});
function sessionsStub(over: Partial<UseChatSessionsResult> = {}): UseChatSessionsResult {
  return {
    sessions: [], isLoading: false, error: null,
    refresh: vi.fn(async () => undefined),
    createSession: vi.fn(async () => row({ sessionId: 'created' })),
    openWith: vi.fn(async () => row({ sessionId: 'opened' })),
    createConversation: vi.fn(async () => row({ sessionId: 'conversation' })),
    openWorkspace: vi.fn(async () => null),
    rename: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    attachBoard: vi.fn(async () => undefined),
    addParticipant: vi.fn(async () => undefined),
    removeParticipant: vi.fn(async () => undefined),
    ...over,
  };
}
const CONFIG: BYOKActiveConfig = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' };

beforeEach(() => { localStorage.clear(); announceSpy.mockClear(); captured = undefined; });

// `byokStored` and `onReconfigureBYOK` are REQUIRED by the deck. tsc --noEmit does not see this file
// (tsconfig.json excludes __tests__); `check-test-types` does, via tsconfig.test.json.
const onReconfigureBYOK = vi.fn();

function mount(): void {
  render(<MemoryRouter><TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={onReconfigureBYOK} /></MemoryRouter>);
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
    expect(msg, 'the fallback is the new-tab label').toBe('New reply in New chat');
  });
});
