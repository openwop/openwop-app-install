/**
 * ADR 1125 D3 (P2) — the inbox card.
 *
 *  - an open request offers no Archive or Delete, and `e` skips it; a finished
 *    one offers both;
 *  - "View activity log" is in the "…" menu, and absent for a deleted run;
 *  - unread reads as a dot with an accessible label, with no type chip;
 *  - identical news collapse into one card, requests never do;
 *  - "Archive read" keeps the open requests;
 *  - line 2 names the asker and the reason, from host-written metadata only.
 *
 * Sabotage witnesses (each red, then restored): drop `!open &&` from the Archive
 * entry → leg 1; drop the `isOpen` check on `e` → leg 1; drop the `run-deleted`
 * guard on the log entry → leg 3; send `isRequest` false for interrupts → leg 5;
 * call `archiveRead()` without `keep` → leg 6.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { useNotificationStore as RealStore } from '../notificationStore.js';
import type { Notification } from '../types.js';
import { messages as en } from '../i18n/en.js';
import { askerOf, groupCards, reasonOf } from '../inboxCards.js';

type StoreState = ReturnType<typeof RealStore.getState>;
const store = vi.hoisted(() => ({
  notifications: [] as unknown[],
  archive: vi.fn(),
  archiveRead: vi.fn(),
}));
const storeState = (): Partial<StoreState> => ({
  notifications: store.notifications as Notification[], unreadCount: 0, loading: false, error: null,
  refresh: vi.fn(), markAllRead: vi.fn(), markAsRead: vi.fn(), markAsUnread: vi.fn(), markRead: vi.fn(),
  archive: store.archive, archiveRead: store.archiveRead, delete: vi.fn(),
} as Partial<StoreState>);
vi.mock('../notificationStore.js', () => ({
  useNotificationStore: Object.assign(
    (sel?: (s: Partial<StoreState>) => unknown) => (sel ? sel(storeState()) : storeState()),
    { setState: vi.fn() },
  ),
}));
const listOpenInterrupts = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../../client/interruptsClient.js', () => ({ listOpenInterrupts }));
vi.mock('../NeedsYouInbox.js', () => ({ NeedsYouInbox: () => null }));
vi.mock('../DelegationSection.js', () => ({ DelegationSection: () => null }));
vi.mock('../TeamsDeliverySection.js', () => ({ TeamsDeliverySection: () => null }));
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => ({ user: { uid: 'u-1' } }) }));
vi.mock('../../auth/backendSession.js', () => ({ useBackendSession: () => ({ user: null }) }));

const { NotificationsPage } = await import('../NotificationsPage.js');

Element.prototype.scrollIntoView = vi.fn();
afterEach(() => { cleanup(); vi.clearAllMocks(); store.notifications = []; window.history.replaceState({}, '', '/'); });

const now = new Date().toISOString();
const request = (over: Partial<Notification> = {}): Notification => ({
  notificationId: 'n-req', tenantId: 't', type: 'openwop-app.workflow.approval-needed', priority: 'normal', status: 'read',
  title: 'Approval needed: Send the proposal', message: 'Send the proposal — $18,400 to Northfield', createdAt: now,
  runId: 'run-1', interruptId: 'i-1', ...over,
} as Notification);
const news = (id: string, over: Partial<Notification> = {}): Notification => ({
  notificationId: id, tenantId: 't', type: 'workflow.completed', priority: 'normal', status: 'read',
  title: 'Weekly digest finished', message: 'Weekly digest finished', createdAt: now, runId: `run-${id}`, ...over,
} as Notification);
const renderAt = (url = '/inbox') => {
  window.history.replaceState({}, '', url);
  return render(<MemoryRouter initialEntries={[url]}><NotificationsPage /></MemoryRouter>);
};
const card = (id: string): HTMLElement => document.querySelector(`[data-notification-id="${id}"]`) as HTMLElement;
const menuItems = (id: string): string[] => {
  fireEvent.click(within(card(id)).getByRole('button', { name: en.cardMoreActions }));
  const items = screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  return items;
};

describe('ADR 1125 D3 — the inbox card', () => {
  it('leg 1: an open request offers no Archive or Delete, and `e` skips it', () => {
    store.notifications = [request()];
    renderAt();
    const items = menuItems('n-req');
    expect(items).not.toContain(en.archive);
    expect(items).not.toContain('Delete');
    expect(items).toContain(en.rowMarkUnread);
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'e' });
    expect(store.archive).not.toHaveBeenCalled();
  });

  it('leg 2: a finished request offers Archive and Delete again', () => {
    store.notifications = [request({ metadata: { resolution: { state: 'approved', at: now } } })];
    renderAt('/inbox?notification=n-req');
    const items = menuItems('n-req');
    expect(items).toContain(en.archive);
    expect(items).toContain('Delete');
  });

  it('leg 3: View activity log is in the menu, and absent for a deleted run', () => {
    store.notifications = [request()];
    renderAt();
    expect(menuItems('n-req')).toContain(en.cardActivityLog);
    cleanup();
    store.notifications = [request({ metadata: { resolution: { state: 'run-deleted', at: now } } })];
    renderAt('/inbox?notification=n-req');
    expect(menuItems('n-req')).not.toContain(en.cardActivityLog);
  });

  it('leg 4: unread is a labelled dot; there is no type chip or Unread chip', () => {
    store.notifications = [request({ status: 'unread', priority: 'high' })];
    renderAt();
    const c = card('n-req');
    expect(within(c).getByRole('img', { name: en.cardUnread })).toBeTruthy();
    expect(c.querySelector('.chip--accent')).toBeNull();
    expect(within(c).queryByText(en.typeApprovalNeeded)).toBeNull();
    // high stays visible; normal shows no priority chip at all
    expect(within(c).getByText(en.priorityHigh)).toBeTruthy();
  });

  it('leg 5: identical news collapse and expand in place; requests never collapse', () => {
    // Two IDENTICAL finished requests: on Updates beside the news, and still never collapsed.
    const done = { metadata: { resolution: { state: 'approved', at: now } } };
    store.notifications = [news('a'), news('b'), news('c'), request({ notificationId: 'r1', ...done }), request({ notificationId: 'r2', interruptId: 'i-2', ...done })];
    renderAt('/inbox?notification=r1');
    fireEvent.click(screen.getByRole('button', { name: /^Updates/ }));
    expect(card('a')).toBeTruthy();
    expect(card('b')).toBeNull();
    expect(within(card('a')).getByText('· 3 times')).toBeTruthy();
    expect(card('r1')).toBeTruthy();
    expect(card('r2')).toBeTruthy();
    fireEvent.click(within(card('a')).getByRole('button', { name: 'Show all 3' }));
    expect(card('b')).toBeTruthy();
    expect(card('c')).toBeTruthy();
  });

  it('leg 6: Archive read keeps the open requests', () => {
    store.notifications = [request(), news('a')];
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: /Archive read/ }));
    expect(store.archiveRead).toHaveBeenCalledWith(['n-req']);
    expect(screen.getByRole('button', { name: /Archive read/ }).textContent).toContain('(1)');
  });

  it('leg 7: line 2 names the asker and the reason; the message is dropped when it repeats the title', () => {
    store.notifications = [request({ status: 'unread', message: 'Approval needed: Send the proposal', metadata: { asker: 'Send the proposal', reason: { kind: 'role', role: 'admin' } } })];
    renderAt();
    const c = card('n-req');
    expect(within(c).getByText('from Send the proposal')).toBeTruthy();
    expect(within(c).getByText(en.cardReasonAdmins)).toBeTruthy();
    expect(c.querySelector('.notifpage-card-message')).toBeNull();
  });
});

describe('ADR 1125 D3/D5 — the metadata readers take host shapes only', () => {
  it('reads a named or role reason, and nothing else', () => {
    const n = (metadata: Record<string, unknown>) => ({ metadata } as unknown as Notification);
    expect(reasonOf(n({ reason: { kind: 'named' } }))).toEqual({ kind: 'named' });
    expect(reasonOf(n({ reason: { kind: 'role', role: 'admin' } }))).toEqual({ kind: 'role', role: 'admin' });
    expect(reasonOf(n({ reason: { kind: 'role', role: '<b>x</b>' } }))).toBeUndefined();
    expect(reasonOf(n({ reason: { kind: 'person', who: 'u-1' } }))).toBeUndefined();
    expect(askerOf(n({ asker: '  ' }))).toBeUndefined();
    expect(askerOf(n({ asker: 42 }))).toBeUndefined();
    expect(askerOf(n({ asker: 'x'.repeat(200) }))?.length).toBe(80);
  });

  it('collapses on type, title and asker together', () => {
    const g = groupCards([news('a'), news('b', { metadata: { asker: 'Other' } }), news('c', { type: 'workflow.failed' }), news('d')]);
    expect(g.map((x) => [x.key, x.rest.map((r) => r.notificationId)])).toEqual([['a', ['d']], ['b', []], ['c', []]]);
  });
});
