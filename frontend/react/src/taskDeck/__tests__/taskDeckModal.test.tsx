/**
 * ADR 0902 D6/D7 — the run deck leads somewhere a viewer can follow and says
 * when it is bounded.
 *
 *  - A card in a chat session links to that conversation (`/chat?conversation=`).
 *  - A blocker with no conversation links to the Inbox; its wait reads by kind.
 *  - "Open run" (`/runs/:id`, admin-tier) renders ONLY for a caller who may open
 *    it (ADR 0844 D4: no link a viewer cannot follow). The REAL `isAdminCaller`
 *    decides, fed typed `EffectiveAccess` values; only the cached read is mocked.
 *  - `truncated` and a capped bucket ("showing N of M") are said, not hidden.
 *  - A deck with live work re-polls; a deck of finished work does not.
 *
 * Sabotage that turns it red: rendering "Open run" for every caller, or
 * `isAdminCaller` no longer admitting the admin role; an unencoded run or
 * conversation id; Inbox links for a timer wait; the raw interrupt kind as the
 * wait text; hiding "Showing N of M" or the truncated note; no poll, a poll for
 * blocked-only decks, or a second load while one is in flight (TD2CD-3/6);
 * a `disabled` Refresh (TD2UX-1); an aria-label on the entry button (TD2UX-2);
 * the tile leaving delegated work out (TD2UX-4); the raw client text or no
 * announcement on a failed load (TD2UX-5); a cancelled run also showing a
 * Failed chip (TD2UX-9).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { TaskCard, TaskDeck } from '../taskDeckClient.js';
import type { EffectiveAccess } from '../../client/accessClient.js';
import { announce, currentAnnouncements } from '../../ui/announce.js';

const MEMBER: EffectiveAccess = { roles: ['member'], scopes: ['runs:read'], basis: 'member' };
/** Admitted ONLY by the `roles.includes('admin')` arm of the real predicate. */
const ADMIN: EffectiveAccess = { roles: ['admin'], scopes: [], basis: 'member' };
const access: { current: EffectiveAccess } = vi.hoisted(() => ({ current: { roles: [], scopes: [], basis: 'none' } }));
const getTaskDeck = vi.fn<typeof import('../taskDeckClient.js')['getTaskDeck']>();

vi.mock('../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<typeof import('../../client/useEffectiveAccess.js')>()),
  useEffectiveAccessState: () => ({ access: access.current, resolved: true }),
}));
vi.mock('../taskDeckClient.js', async (orig) => ({
  ...(await orig<typeof import('../taskDeckClient.js')>()),
  getTaskDeck: (conversationRunId?: string) => getTaskDeck(conversationRunId),
}));

const { default: TaskDeckModal } = await import('../TaskDeckModal.js');
const { TaskDeckButton } = await import('../TaskDeckPanel.js');
const { default: TaskDeckTile } = await import('../../features/dashboard/tiles/TaskDeckTile.js');

const now = new Date().toISOString();
const card = (over: Partial<TaskCard>): TaskCard => ({ runId: 'r1', title: 'Weekly report', status: 'running', startedAt: now, updatedAt: now, children: [], ...over });
const deckOf = (over: Partial<TaskDeck>): TaskDeck => ({
  buckets: { pending: [], running: [], blocked: [], delegated: [], completed: [], failed: [] },
  counts: { pending: 0, running: 0, blocked: 0, delegated: 0, completed: 0, failed: 0 },
  truncated: false,
  ...over,
});
const open = () => render(<MemoryRouter><TaskDeckModal onClose={() => {}} /></MemoryRouter>);

beforeEach(() => {
  getTaskDeck.mockReset();
  access.current = MEMBER;
  // ui/announce keeps module-level live-region text: start every case clean.
  announce('');
  announce('', { assertive: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ADR 0902 D7 — links a viewer can follow', () => {
  it('a chat-session card opens its conversation; a member gets no admin-tier run link', async () => {
    getTaskDeck.mockResolvedValue(deckOf({ buckets: { ...deckOf({}).buckets, running: [card({ conversationId: 's 42' })] }, counts: { ...deckOf({}).counts!, running: 1 } }));
    open();
    const link = await screen.findByRole('link', { name: 'Open conversation' });
    expect(link.getAttribute('href')).toBe('/chat?conversation=s%2042');
    expect(screen.queryByRole('link', { name: 'Open run' })).toBeNull();
  });

  it('CONTROL: an admin also gets the run page link', async () => {
    access.current = ADMIN;
    getTaskDeck.mockResolvedValue(deckOf({ buckets: { ...deckOf({}).buckets, running: [card({ runId: 'r 9' })] }, counts: { ...deckOf({}).counts!, running: 1 } }));
    open();
    const link = await screen.findByRole('link', { name: 'Open run' });
    expect(link.getAttribute('href')).toBe('/runs/r%209');
  });

  it('a blocker without a conversation links to the Inbox and says what it waits for', async () => {
    getTaskDeck.mockResolvedValue(deckOf({ buckets: { ...deckOf({}).buckets, blocked: [card({ status: 'blocked', blockedReason: 'approval' })] }, counts: { ...deckOf({}).counts!, blocked: 1 } }));
    open();
    expect((await screen.findByRole('link', { name: 'See what needs you' })).getAttribute('href')).toBe('/inbox');
    expect(screen.getByText('Waiting for an approval')).toBeTruthy();
  });

  it('an unknown interrupt kind reads as a generic wait, never the raw kind', async () => {
    getTaskDeck.mockResolvedValue(deckOf({ buckets: { ...deckOf({}).buckets, blocked: [card({ status: 'blocked', blockedReason: 'walkthrough-step' })] }, counts: { ...deckOf({}).counts!, blocked: 1 } }));
    open();
    expect(await screen.findByText('Waiting')).toBeTruthy();
    expect(screen.queryByText(/walkthrough-step/)).toBeNull();
  });
});

describe('ADR 0902 D6 — bounds are said', () => {
  it('a truncated deck and a capped bucket both say so', async () => {
    const cards = Array.from({ length: 50 }, (_, i) => card({ runId: `c${i}`, status: 'completed' }));
    getTaskDeck.mockResolvedValue(deckOf({ buckets: { ...deckOf({}).buckets, completed: cards }, counts: { ...deckOf({}).counts!, completed: 73 }, truncated: true }));
    open();
    expect(await screen.findByText('Showing 50 of 73')).toBeTruthy();
    expect(screen.getByText(/Older runs may be missing/)).toBeTruthy();
  });

  it('CONTROL: a whole, small deck says neither', async () => {
    getTaskDeck.mockResolvedValue(deckOf({ buckets: { ...deckOf({}).buckets, completed: [card({ status: 'completed' })] }, counts: { ...deckOf({}).counts!, completed: 1 } }));
    open();
    await screen.findByText('Weekly report');
    expect(screen.queryByText(/Showing \d+ of/)).toBeNull();
    expect(screen.queryByText(/Older runs may be missing/)).toBeNull();
  });
});

describe('ADR 0902 D7 (architect A2) — polls only while work is live', () => {
  it('re-reads a deck with running work, not one of finished work', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getTaskDeck.mockResolvedValue(deckOf({ buckets: { ...deckOf({}).buckets, running: [card({})] }, counts: { ...deckOf({}).counts!, running: 1 } }));
    open();
    await waitFor(() => expect(getTaskDeck).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await waitFor(() => expect(getTaskDeck).toHaveBeenCalledTimes(2));
    cleanup();

    getTaskDeck.mockReset();
    getTaskDeck.mockResolvedValue(deckOf({ buckets: { ...deckOf({}).buckets, completed: [card({ status: 'completed' })] }, counts: { ...deckOf({}).counts!, completed: 1 } }));
    open();
    await waitFor(() => expect(getTaskDeck).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(getTaskDeck).toHaveBeenCalledTimes(1);
  });
});

const only = (bucket: keyof TaskDeck['buckets'], c: TaskCard): TaskDeck =>
  deckOf({ buckets: { ...deckOf({}).buckets, [bucket]: [c] }, counts: { ...deckOf({}).counts!, [bucket]: 1 } });

describe('ADR 0902 grade-ux fixes', () => {
  it('TD2UX-1: Refresh is never disabled, so a poll cannot drop focus out of the dialog', async () => {
    let release: (d: TaskDeck) => void = () => {};
    getTaskDeck.mockResolvedValueOnce(only('running', card({})));
    getTaskDeck.mockImplementationOnce(() => new Promise<TaskDeck>((r) => { release = r; }));
    open();
    const btn = await screen.findByRole('button', { name: 'Refresh' });
    btn.focus();
    await act(async () => { btn.click(); });
    const busy = screen.getByRole('button', { name: 'Refreshing…' });
    expect((busy as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(busy);
    await act(async () => { release(only('running', card({}))); });
  });

  it('TD2CD-6: a second load while one is in flight is skipped', async () => {
    getTaskDeck.mockResolvedValueOnce(only('running', card({})));
    getTaskDeck.mockImplementationOnce(() => new Promise<TaskDeck>(() => {}));
    open();
    const btn = await screen.findByRole('button', { name: 'Refresh' });
    await act(async () => { btn.click(); });
    await act(async () => { screen.getByRole('button', { name: 'Refreshing…' }).click(); });
    expect(getTaskDeck).toHaveBeenCalledTimes(2);
  });

  it('TD2UX-2: the entry button\'s accessible name is its visible label', () => {
    render(<MemoryRouter><TaskDeckButton /></MemoryRouter>);
    const btn = screen.getByRole('button', { name: 'Run deck' });
    expect(btn.textContent?.trim()).toBe('Run deck');
    expect(btn.getAttribute('aria-label')).toBeNull();
  });

  it('TD2UX-5: a failed first load shows the sentence, never the client\'s raw status text', async () => {
    getTaskDeck.mockRejectedValue(new Error('getTaskDeck returned 500'));
    open();
    expect(await screen.findByText('Couldn’t load the run deck.')).toBeTruthy();
    expect(screen.queryByText(/returned 500/)).toBeNull();
    // The error is also SPOKEN (assertively), as the sentence — never the raw text.
    await waitFor(() => expect(currentAnnouncements().assertive).toContain('Couldn’t load the run deck.'));
    expect(currentAnnouncements().assertive).not.toMatch(/returned 500/);
  });

  it('TD2UX-9: a cancelled run reads Cancelled, not Failed', async () => {
    getTaskDeck.mockResolvedValue(only('failed', card({ status: 'failed', cancelled: true })));
    open();
    expect(await screen.findByText('Cancelled')).toBeTruthy();
    // "Failed" appears once: the bucket heading, never as the card's chip.
    const failed = screen.getAllByText('Failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.closest('h3')).not.toBeNull();
  });

  it('TD2UX-10: a timer wait gets no Inbox link (there is nothing there to act on)', async () => {
    getTaskDeck.mockResolvedValue(only('blocked', card({ status: 'blocked', blockedReason: 'timer' })));
    open();
    expect(await screen.findByText('Waiting for a scheduled time')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'See what needs you' })).toBeNull();
  });

  it('TD2CD-3: a deck whose only live work is blocked does not poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getTaskDeck.mockResolvedValue(only('blocked', card({ status: 'blocked', blockedReason: 'approval' })));
    open();
    await waitFor(() => expect(getTaskDeck).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(getTaskDeck).toHaveBeenCalledTimes(1);
  });

  it('TD2UX-4: the home tile counts delegated work and is not "empty" when that is all there is', async () => {
    getTaskDeck.mockResolvedValue(deckOf({ counts: { ...deckOf({}).counts!, delegated: 3 } }));
    render(<MemoryRouter><TaskDeckTile compact={false} /></MemoryRouter>);
    expect(await screen.findByText('Delegated')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.queryByText('No active runs right now.')).toBeNull();
  });
});
