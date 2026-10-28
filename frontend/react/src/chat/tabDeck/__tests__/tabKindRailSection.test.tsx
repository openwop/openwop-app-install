/**
 * ADR 0785 D5 follow-on — a deck tab kind may contribute a section to the
 * Conversations rail. Pins the SEAM, not any one feature:
 *   - the section renders only while the kind's feature is visible (same rule as
 *     the New-tab menu);
 *   - `openNewTab({ seed })`'s seed is visible to the kind's Component at its FIRST
 *     render, so a feature can pre-seed per-tab state its Component reads at mount
 *     (the deck seeds before dispatching the open; React batches the mount after);
 *   - `focusTab` focuses an existing tab; `openTabIds` lists this kind's tabs.
 * And the layering it relies on: core `chat/` never imports the excludable
 * claude-code feature, and the deck + rail import no feature at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DeckRailSectionProps, DeckTabKindProps } from '../tabKindRegistry.js';
import type { UseChatSessionsResult } from '../../hooks/useChatSessions.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';

// ADR 0978 D4 — the deck resolves the active workspace before it restores.
vi.mock('../../../client/workspaceClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/workspaceClient.js')>()),
  listMyWorkspaces: async () => ({ workspaces: [], active: 'ws-test', personal: 'ws-test' }),
}));
vi.mock('../TabSession.js', () => ({
  TabSession: ({ sessionId }: { sessionId: string }) => <div data-testid="tabsession" data-sid={sessionId} />,
}));
vi.mock('../../hooks/useChatSessions.js', () => ({ useChatSessions: () => sessionsStub() }));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: null }) }));
// The deck's two other server reads — not under test here, and never live (ADR 0661).
vi.mock('../../conversations/useRunningConversations.js', () => ({ useRunningConversations: () => new Set<string>() }));
vi.mock('../../reviews/reviewStatusStore.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../reviews/reviewStatusStore.js')>();
  real.useReviewStatusStore.setState({ connect: () => Promise.resolve(), disconnect: () => {} });
  return real;
});

const visibility = vi.hoisted(() => ({ visible: new Set<string>() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureVisible: () => (id?: string) => !id || visibility.visible.has(id),
}));

import { TabChatDeck } from '../TabChatDeck.js';
import { registerDeckTabKind, __clearDeckTabKindsForTest } from '../tabKindRegistry.js';

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

/** Per-tab state the fake kind reads AT MOUNT — the pre-seed contract. */
const seeded = new Map<string, string>();
const seenAtMount: Array<{ tabId: string; value: string | undefined }> = [];

function FakeKind({ tabId }: DeckTabKindProps): JSX.Element {
  const [value] = (() => { const v = seeded.get(tabId); seenAtMount.push({ tabId, value: v }); return [v]; })();
  return <div data-testid="fake-kind" data-tab={tabId}>{value ?? 'picker'}</div>;
}
function FakeSection({ openTabIds, focusTab, openNewTab }: DeckRailSectionProps): JSX.Element {
  return (
    <section aria-label="Fake tools">
      <span data-testid="open-ids">{openTabIds.join(',')}</span>
      <button type="button" onClick={() => openNewTab({ seed: (id) => seeded.set(id, 'session-42'), title: 'Seeded tab' })}>open seeded</button>
      <button type="button" onClick={() => { if (openTabIds[0]) focusTab(openTabIds[0]); }}>focus first</button>
    </section>
  );
}

beforeEach(() => {
  localStorage.clear();
  seeded.clear();
  seenAtMount.length = 0;
  visibility.visible = new Set();
  registerDeckTabKind({ kind: 'fake-tool', label: () => 'Fake tool', featureId: 'fake-tool', Component: FakeKind, RailSection: FakeSection });
});
afterEach(() => { cleanup(); __clearDeckTabKindsForTest(); });

async function renderDeck(): Promise<void> {
  await act(async () => {
    render(<MemoryRouter><TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} /></MemoryRouter>);
  });
}

describe('deck tab kind rail sections', () => {
  it('renders nothing for a kind whose feature is NOT visible', async () => {
    await renderDeck();
    expect(screen.queryByRole('region', { name: 'Fake tools' })).toBeNull();
    expect(screen.queryByText('open seeded')).toBeNull();
  });

  it('renders the section inside the Conversations rail when the feature is visible', async () => {
    visibility.visible = new Set(['fake-tool']);
    await renderDeck();
    const section = screen.getByRole('region', { name: 'Fake tools' });
    expect(section.closest('.conversations-rail')).not.toBeNull();
  });

  it("openNewTab's seed is visible at the kind's first render, labels the tab, and focusTab returns to it", async () => {
    visibility.visible = new Set(['fake-tool']);
    await renderDeck();
    await act(async () => { fireEvent.click(screen.getByText('open seeded')); });

    const kind = screen.getByTestId('fake-kind');
    const tabId = kind.getAttribute('data-tab')!;
    expect(tabId).toMatch(/^fake-tool-/);
    // The first render of the kind already saw the seed — never the picker.
    expect(seenAtMount.find((m) => m.tabId === tabId)?.value).toBe('session-42');
    expect(kind.textContent).toBe('session-42');
    expect(screen.getByRole('tab', { name: /Seeded tab/ })).toBeTruthy();
    expect(screen.getByTestId('open-ids').textContent).toBe(tabId);

    // Switch to the conversation tab (a deck tab carries data-sid; the rail's own
    // mode tabs do not), then focus the kind tab again from the rail.
    const convTab = screen.getAllByRole('tab').find((el) => el.getAttribute('data-sid') && !/Seeded tab/.test(el.textContent ?? ''));
    expect(convTab, 'the bootstrapped conversation tab must exist to switch away to').toBeTruthy();
    await act(async () => { fireEvent.click(convTab!); });
    expect(screen.getByRole('tab', { name: /Seeded tab/ }).getAttribute('aria-selected')).toBe('false'); // really switched away
    await act(async () => { fireEvent.click(screen.getByText('focus first')); });
    expect(screen.getByRole('tab', { name: /Seeded tab/ }).getAttribute('aria-selected')).toBe('true');
    // Focusing never opened a second tab.
    expect(screen.getAllByTestId('fake-kind')).toHaveLength(1);
  });
});

describe('layering (ADR 0630 layer 1)', () => {
  const SRC = join(process.cwd(), 'src');
  const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
  const importsOf = (file: string): string[] =>
    [...stripComments(readFileSync(file, 'utf8')).matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]!);

  it('no core chat/ file imports the excludable claude-code feature', () => {
    const offenders = walk(join(SRC, 'chat')).filter((f) => importsOf(f).some((s) => /features\/claude-code\b/.test(s)));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('the deck and the rail import no feature at all (kinds arrive through the registry)', () => {
    const files = [...walk(join(SRC, 'chat', 'tabDeck')), ...walk(join(SRC, 'chat', 'leftRail')), join(SRC, 'chat', 'conversations', 'ConversationsRail.tsx')];
    expect(files.length).toBeGreaterThan(5); // the walk found the files (never vacuously green)
    const offenders = files.filter((f) => importsOf(f).some((s) => /(^|\/)features\//.test(s)));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
