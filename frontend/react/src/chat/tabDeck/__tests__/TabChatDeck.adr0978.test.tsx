/**
 * ADR 0978 — the deck decisions round 2 found missing (feature loop row 55). Each
 * describe pins one decision through the deck itself, not a helper:
 *   D1 — a tab that is waiting on the user or running a workflow is never auto-evicted,
 *        whether the signal is the tab's own live report or the server's;
 *   D2 — at the hard ceiling with every tab busy, an open is REFUSED (no growth, no
 *        eviction, no side effect left behind — the kind seed is the /architect H1 case);
 *   D3 — the mount sweep deletes only an empty chat the caller owns alone;
 *   D4 — the working set is per workspace, and the legacy per-user set is forgotten
 *        only once its tabs prove to belong to this workspace;
 *   D5 — a kind tab whose feature is off never mounts; drafts key on the uid;
 *   D6 — deck keyboard actions move DOM focus; closing a busy tab says where it went.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useEffect } from 'react';
import type { UseChatSessionsResult } from '../../hooks/useChatSessions.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';
import type { DeckRailSectionProps } from '../tabKindRegistry.js';
import type { TabDeckState } from '../tabDeckModel.js';

const h = vi.hoisted(() => ({
  uid: 'u1' as string | null,
  workspace: 'ws-test',
  blocked: new Set<string>(),
  liveRunning: new Set<string>(),
  streaming: new Set<string>(),
  running: new Set<string>(),
  sessions: [] as ChatSessionHeader[],
  remove: null as null | ((id: string) => Promise<void>),
  tenantIds: new Map<string, string | undefined>(),
  visible: new Set<string>(),
  toasts: [] as string[],
}));

vi.mock('../../../client/workspaceClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/workspaceClient.js')>()),
  listMyWorkspaces: async () => ({ workspaces: [], active: h.workspace, personal: h.workspace }),
}));
// A TabSession stand-in that reports activity exactly as the real one does
// (`onActivity(sid, lastInboundId, blocked, running)`) and renders a composer.
vi.mock('../TabSession.js', () => ({
  TabSession: ({ sessionId, onActivity, onStreamingChange, tenantId }: { sessionId: string; tenantId?: string; onActivity: (sid: string, last: string | null, blocked: boolean, running?: boolean) => void; onStreamingChange: (sid: string, isSending: boolean) => void }) => {
    h.tenantIds.set(sessionId, tenantId);
    // As the real TabSession: `isSending` → onStreamingChange; a workflow run in flight →
    // onActivity(running=true); an open HITL interrupt → onActivity(blocked=true).
    useEffect(() => { onStreamingChange(sessionId, h.streaming.has(sessionId)); }, [sessionId, onStreamingChange]);
    useEffect(() => { onActivity(sessionId, null, h.blocked.has(sessionId), h.liveRunning.has(sessionId)); }, [sessionId, onActivity]);
    return <div data-testid="tabsession" data-sid={sessionId}><textarea aria-label={`composer ${sessionId}`} /></div>;
  },
}));
// The close-time reap counts a deck-minted tab's messages before deleting it.
vi.mock('../../../client/chatSessionsClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/chatSessionsClient.js')>()),
  listChatSessionMessagesPage: async () => ({ messages: [], nextCursor: null }),
}));
vi.mock('../../hooks/useChatSessions.js', () => ({ useChatSessions: () => sessionsStub() }));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: h.uid ? { uid: h.uid } : null }) }));
vi.mock('../../conversations/useRunningConversations.js', () => ({ useRunningConversations: () => h.running }));
vi.mock('../../reviews/reviewClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../reviews/reviewClient.js')>()),
  listReviews: async () => [],
  getReview: async () => { throw new Error('not used in this test'); },
}));
vi.mock('../../../ui/toast.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../ui/toast.js')>();
  return { ...real, toast: { ...real.toast, info: (m: string) => { h.toasts.push(m); } } };
});
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureVisible: () => (id?: string) => !id || h.visible.has(id),
}));

import { TabChatDeck } from '../TabChatDeck.js';
import { tabButtonId } from '../TabStrip.js';
import { HARD_MAX_TABS } from '../tabDeckModel.js';
import { registerDeckTabKind, __clearDeckTabKindsForTest } from '../tabKindRegistry.js';
import { LS_TABDECK_VERSION } from '../../lib/storageKeys.js';

const OLD = '2026-01-01T00:00:00.000Z';
const row = (o: Partial<ChatSessionHeader> & { sessionId: string }): ChatSessionHeader => ({
  tenantId: 't1', title: o.sessionId, createdAt: OLD, updatedAt: OLD, messageCount: 1, type: 'agent', ...o,
});
function sessionsStub(): UseChatSessionsResult {
  return {
    sessions: h.sessions, isLoading: false, error: null,
    refresh: vi.fn(async () => undefined),
    createSession: vi.fn(async () => row({ sessionId: 'created' })),
    openWith: vi.fn(async () => row({ sessionId: 'opened' })),
    createConversation: vi.fn(async () => row({ sessionId: 'conversation' })),
    openWorkspace: vi.fn(async () => null),
    rename: vi.fn(async () => undefined),
    remove: h.remove ?? vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    attachBoard: vi.fn(async () => undefined),
    addParticipant: vi.fn(async () => undefined),
    removeParticipant: vi.fn(async () => undefined),
  };
}
const CONFIG: BYOKActiveConfig = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' };

const KEY = (subject: string): string => `openwop-app.chat.tabdeck:${subject}`;
function seedDeck(subject: string, ids: string[], opts: { active?: string; kinds?: Record<string, string> } = {}): void {
  const state: TabDeckState = {
    tabs: ids.map((id, i) => ({ sessionId: id, pinned: false, lastActiveSeq: i + 1, ...(opts.kinds?.[id] ? { kind: opts.kinds[id] } : {}) })),
    activeSessionId: opts.active ?? ids[ids.length - 1] ?? null,
    seq: ids.length,
  };
  localStorage.setItem(KEY(subject), JSON.stringify({ v: LS_TABDECK_VERSION, subject, state }));
}
function storedIds(subject: string): string[] | null {
  const raw = localStorage.getItem(KEY(subject));
  return raw ? (JSON.parse(raw) as { state: TabDeckState }).state.tabs.map((t) => t.sessionId) : null;
}

async function mount(): Promise<void> {
  await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
}
const stripIds = (): string[] =>
  within(screen.getByRole('tablist', { name: 'Open chat tabs' })).getAllByRole('tab').map((el) => el.getAttribute('data-sid')!);
async function clickNewTab(): Promise<void> {
  const btn = screen.getAllByRole('button', { name: 'New chat' }).find((b) => !b.closest('.conversations-rail'))!;
  await act(async () => { fireEvent.click(btn); });
}
async function key(code: string, extra: Partial<KeyboardEventInit> = {}): Promise<void> {
  await act(async () => { fireEvent.keyDown(window, { code, altKey: true, ...extra }); });
}

beforeEach(() => {
  localStorage.clear();
  h.uid = 'u1'; h.workspace = 'ws-test';
  h.blocked = new Set(); h.liveRunning = new Set(); h.streaming = new Set(); h.running = new Set(); h.sessions = []; h.remove = null;
  h.tenantIds.clear(); h.visible = new Set(); h.toasts = [];
  __clearDeckTabKindsForTest();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ADR 0978 D1 — the tabs that need you are never auto-evicted', () => {
  it('a background tab waiting on a HITL interrupt survives the soft cap (its own live report)', async () => {
    seedDeck('u1@ws-test', ['blk'], { active: 'blk' });
    h.sessions = [row({ sessionId: 'blk' })];
    h.blocked.add('blk'); // the mounted stand-in reports blocked=true, as a real HITL tab does
    await mount();
    for (let i = 0; i < 8; i++) await clickNewTab(); // 9 tabs requested against a soft cap of 8
    expect(stripIds()).toContain('blk'); // the LRU tab, but waiting on you — never the victim
    expect(stripIds()).toHaveLength(8);
  });

  it('a background tab running a /workflow survives the soft cap (its own live report)', async () => {
    seedDeck('u1@ws-test', ['wf'], { active: 'wf' });
    h.sessions = [row({ sessionId: 'wf' })];
    h.liveRunning.add('wf');
    await mount();
    for (let i = 0; i < 8; i++) await clickNewTab();
    expect(stripIds()).toContain('wf');
    expect(stripIds()).toHaveLength(8);
  });

  it('a background tab whose chat turn is streaming survives the soft cap', async () => {
    seedDeck('u1@ws-test', ['st'], { active: 'st' });
    h.sessions = [row({ sessionId: 'st' })];
    h.streaming.add('st');
    await mount();
    for (let i = 0; i < 8; i++) await clickNewTab();
    expect(stripIds()).toContain('st');
    expect(stripIds()).toHaveLength(8);
  });

  it('a restored, never-visited tab with a run in flight server-side survives (ADR 0776 P2 signal)', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `r${i}`);
    seedDeck('u1@ws-test', ids, { active: 'r7' });
    h.sessions = ids.map((id) => row({ sessionId: id }));
    h.running = new Set(['r0']); // r0 is the LRU tab and is not mounted (never visited)
    await mount();
    await clickNewTab();
    expect(stripIds()).toContain('r0');
    expect(stripIds()).not.toContain('r1'); // the next-least-recent idle tab went instead
  });
});

describe('ADR 0978 D2 — the hard ceiling is absolute', () => {
  const full = (): string[] => Array.from({ length: HARD_MAX_TABS }, (_, i) => `b${i}`);

  it('refuses a new tab when every tab is busy: no growth, a toast that says why', async () => {
    const ids = full();
    seedDeck('u1@ws-test', ids, { active: 'b0' });
    h.sessions = ids.map((id) => row({ sessionId: id }));
    h.running = new Set(ids);
    await mount();
    await clickNewTab();
    expect(stripIds()).toEqual(ids);
    expect(h.toasts).toContain('Every open tab is busy, so nothing opened. Close a tab to open another.');
  });

  it('a refused kind open never runs the kind seed (/architect H1)', async () => {
    const ids = full();
    seedDeck('u1@ws-test', ids, { active: 'b0' });
    h.sessions = ids.map((id) => row({ sessionId: id }));
    h.running = new Set(ids);
    h.visible.add('kind-feature');
    const seed = vi.fn();
    registerDeckTabKind({
      kind: 'fake', label: () => 'Fake', featureId: 'kind-feature',
      Component: () => <div data-testid="fake-kind" />,
      RailSection: ({ openNewTab }: DeckRailSectionProps) => <button type="button" onClick={() => openNewTab({ seed })}>open fake</button>,
    });
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'open fake' })); });
    expect(seed).not.toHaveBeenCalled();
    expect(stripIds()).toHaveLength(HARD_MAX_TABS);
  });
});

describe('ADR 0978 D3 — the mount sweep deletes only what the caller owns alone', () => {
  it('deletes a stale owner-only empty chat; spares a meta-less legacy row and a DM', async () => {
    const removed: string[] = [];
    h.remove = async (id) => { removed.push(id); };
    h.sessions = [
      row({ sessionId: 'mine', messageCount: 0, ownerUserId: 'u1', participants: [{ subjectRef: 'user:u1', role: 'owner', addedAt: OLD }] }),
      row({ sessionId: 'legacy', messageCount: 0, participants: [] }),
      row({ sessionId: 'dm', messageCount: 0, ownerUserId: 'u1', participants: [{ subjectRef: 'user:u1', role: 'owner', addedAt: OLD }, { subjectRef: 'agent:iris', role: 'member', addedAt: OLD }] }),
    ];
    await mount();
    expect(removed).toEqual(['mine']);
  });
});

describe('ADR 0978 D4 — the working set is per workspace', () => {
  it('never touches another workspace\'s working set', async () => {
    seedDeck('u1@ws-other', ['a1', 'a2']);
    h.sessions = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await mount();
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(storedIds('u1@ws-other')).toEqual(['a1', 'a2']);
    expect(storedIds('u1@ws-test')).not.toBeNull(); // this workspace saved its own set
  });

  it('keeps the legacy per-user set when none of its tabs belong to this workspace', async () => {
    seedDeck('u1', ['elsewhere1', 'elsewhere2']);
    h.sessions = []; // none of them live here — they belong to another workspace
    await mount();
    expect(storedIds('u1')).toEqual(['elsewhere1', 'elsewhere2']);
    // Nothing was lost (they are kept for their own workspace), so no "deleted" notice.
    expect(h.toasts.some((m) => m.includes('that were deleted'))).toBe(false);
  });

  it('forgets the legacy per-user set once its tabs prove to belong here', async () => {
    seedDeck('u1', ['here', 'gone']);
    h.sessions = [row({ sessionId: 'here' })];
    await mount();
    expect(storedIds('u1')).toBeNull();
    expect(stripIds()).toEqual(['here']);
  });
});

describe('ADR 0978 D5 — parity fixes', () => {
  it('a kind tab whose feature is OFF shows unavailable and never mounts its Component', async () => {
    registerDeckTabKind({ kind: 'offkind', label: () => 'Off', featureId: 'off-feature', Component: () => <div data-testid="off-kind" /> });
    seedDeck('u1@ws-test', ['offkind-1'], { active: 'offkind-1', kinds: { 'offkind-1': 'offkind' } });
    await mount();
    expect(screen.queryByTestId('off-kind')).toBeNull();
    expect(screen.getByText('This tab type is not available here.')).toBeTruthy();
  });

  it('every tab keys its composer draft on the signed-in uid, never a shared "demo"', async () => {
    await mount();
    const [sid] = stripIds();
    expect(h.tenantIds.get(sid!)).toBe('u1');
  });
});

describe('ADR 0978 D6 — keyboard focus and busy close', () => {
  it('Alt+1 moves DOM focus to the first tab button', async () => {
    await mount();
    await clickNewTab();
    const [first] = stripIds();
    (document.activeElement as HTMLElement | null)?.blur();
    await key('Digit1');
    expect(document.activeElement?.id).toBe(tabButtonId(first!));
  });

  it('Alt+W lands focus on the newly active tab, not on <body>', async () => {
    await mount();
    await clickNewTab();
    const [first] = stripIds();
    await key('KeyW');
    expect(document.activeElement?.id).toBe(tabButtonId(first!));
  });

  it('Alt+N focuses the new tab\'s composer once it mounts', async () => {
    await mount();
    await key('KeyN');
    const ids = stripIds();
    const created = ids[ids.length - 1]!;
    expect(document.activeElement?.getAttribute('aria-label')).toBe(`composer ${created}`);
  });

  it('Alt+P pins and unpins the active tab (the pin control has no tab stop)', async () => {
    seedDeck('u1@ws-test', ['p1'], { active: 'p1' });
    h.sessions = [row({ sessionId: 'p1', title: 'Plan' })];
    await mount();
    await key('KeyP');
    expect(screen.getByRole('button', { name: 'Unpin Plan' }).getAttribute('aria-pressed')).toBe('true');
    await key('KeyP');
    expect(screen.getByRole('button', { name: 'Pin Plan' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('closing a tab that is waiting on you says it is still in progress', async () => {
    h.sessions = [row({ sessionId: 'busy', title: 'Quarterly plan' }), row({ sessionId: 'other' })];
    h.blocked.add('busy');
    seedDeck('u1@ws-test', ['busy', 'other'], { active: 'busy' });
    await mount();
    await key('KeyW');
    expect(h.toasts).toContain('"Quarterly plan" is still in progress. Reopen it from Conversations.');
  });
});
