/**
 * ADR 1125 D4 (P3) — the page: Needs you, Updates, Archived.
 *
 *  - ONE count: Needs you = open requests + the approval queue's items (issue 5909),
 *    and "Nothing needs you" shows only when that count is 0;
 *  - the empty state names the last decision, and only a person's decision;
 *  - each row is on one tab: an open request on Needs you, news and finished
 *    requests on Updates;
 *  - a finished request's deep link opens Updates.
 *
 * Sabotage witnesses (each red, then restored):
 *  - drop `+ queueCount` from the count → "one count";
 *  - show the empty state while the queue has items → "the queue alone";
 *  - let Updates show open requests → "each row is on one tab";
 *  - drop the DECISION_STATES filter → "a withdrawn request is not a decision".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useEffect } from 'react';
import type { useNotificationStore as RealStore } from '../notificationStore.js';
import type { Notification } from '../types.js';
import { messages as en } from '../i18n/en.js';

type StoreState = ReturnType<typeof RealStore.getState>;
const store = vi.hoisted(() => ({ notifications: [] as unknown[], queue: 0 }));
const storeState = (): Partial<StoreState> => ({
  notifications: store.notifications as Notification[], unreadCount: 0, loading: false, error: null,
  refresh: vi.fn(), markAllRead: vi.fn(), markAsRead: vi.fn(), markAsUnread: vi.fn(), markRead: vi.fn(),
  archive: vi.fn(), archiveRead: vi.fn(), delete: vi.fn(),
} as Partial<StoreState>);
vi.mock('../notificationStore.js', () => ({
  useNotificationStore: Object.assign(
    (sel?: (s: Partial<StoreState>) => unknown) => (sel ? sel(storeState()) : storeState()),
    { setState: vi.fn() },
  ),
}));
vi.mock('../../client/interruptsClient.js', () => ({ listOpenInterrupts: vi.fn(async () => []) }));
// The queue reports its count up, as the real one does once its lists load.
vi.mock('../NeedsYouInbox.js', () => ({
  NeedsYouInbox: ({ onCountChange }: { onCountChange?: (n: number) => void }) => {
    useEffect(() => { onCountChange?.(store.queue); }, [onCountChange]);
    return store.queue > 0 ? <div data-testid="queue">queue items</div> : null;
  },
}));
vi.mock('../DelegationSection.js', () => ({ DelegationSection: () => null }));
vi.mock('../TeamsDeliverySection.js', () => ({ TeamsDeliverySection: () => null }));
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => ({ user: { uid: 'u-1' } }) }));
vi.mock('../../auth/backendSession.js', () => ({ useBackendSession: () => ({ user: null }) }));

const { NotificationsPage } = await import('../NotificationsPage.js');
Element.prototype.scrollIntoView = vi.fn();
afterEach(() => { cleanup(); vi.clearAllMocks(); store.notifications = []; store.queue = 0; window.history.replaceState({}, '', '/'); });

// A loaded gate box renders slowly (a 52 s run was seen at load 15): wait on
// what the page shows, with room, rather than on testing-library's 1 s default.
const SLOW = { timeout: 10_000 };
const now = new Date().toISOString();
const request = (id: string, over: Partial<Notification> = {}): Notification => ({
  notificationId: id, tenantId: 't', type: 'openwop-app.workflow.approval-needed', priority: 'normal', status: 'read',
  title: `Approval needed: ${id}`, message: 'm', createdAt: now, runId: `run-${id}`, interruptId: `i-${id}`, ...over,
} as Notification);
const finished = (id: string, state: string, title = `Send the proposal ${id}`): Notification =>
  request(id, { title, metadata: { resolution: { state, at: now } } });
const news = (id: string): Notification => ({
  notificationId: id, tenantId: 't', type: 'workflow.completed', priority: 'normal', status: 'read',
  title: `Digest ${id}`, message: 'done', createdAt: now,
} as Notification);
const renderAt = (url = '/inbox') => {
  window.history.replaceState({}, '', url);
  return render(<MemoryRouter initialEntries={[url]}><NotificationsPage /></MemoryRouter>);
};
const tabButton = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}`) });
const card = (id: string) => document.querySelector(`[data-notification-id="${id}"]`);

describe('ADR 1125 D4 — the Inbox tabs and one count', () => {
  it('one count: Needs you is open requests plus the queue (issue 5909)', async () => {
    store.notifications = [request('r1'), news('n1')];
    store.queue = 2;
    renderAt();
    await vi.waitFor(() => expect(tabButton(en.tabNeedsYou).textContent).toContain('3'), SLOW);
    expect(tabButton(en.tabUpdates).textContent).toContain('1');
  });

  it('the queue alone keeps the empty state away; it shows only at 0', async () => {
    store.queue = 1;
    renderAt();
    expect(await screen.findByTestId('queue', {}, SLOW)).toBeTruthy();
    expect(screen.queryByText(en.emptyNeedsYouTitle)).toBeNull();
    cleanup();
    store.queue = 0;
    renderAt();
    expect(await screen.findByText(en.emptyNeedsYouTitle, {}, SLOW)).toBeTruthy();
  });

  it('the empty state names the last decision; a withdrawn request is not a decision', async () => {
    store.notifications = [finished('a', 'approved', 'Send the proposal'), finished('w', 'withdrawn', 'An idle chat')];
    renderAt();
    const empty = await screen.findByText(en.emptyNeedsYouTitle, {}, SLOW);
    const body = empty.closest('[class]')?.parentElement?.textContent ?? document.body.textContent ?? '';
    expect(body).toContain('Last: Approved “Send the proposal”');
    expect(body).not.toContain('An idle chat');
    cleanup();
    store.notifications = [finished('w2', 'withdrawn', 'Only an idle chat')];
    renderAt();
    await screen.findByText(en.emptyNeedsYouTitle, {}, SLOW);
    expect(document.body.textContent).not.toContain('Last:');
  });

  it('each row is on one tab: open requests on Needs you, news and finished requests on Updates', async () => {
    store.notifications = [request('open'), finished('done', 'approved'), news('n')];
    renderAt();
    expect(card('open')).toBeTruthy();
    expect(card('done')).toBeNull();
    expect(card('n')).toBeNull();
    fireEvent.click(tabButton(en.tabUpdates));
    expect(card('open')).toBeNull();
    expect(card('done')).toBeTruthy();
    expect(card('n')).toBeTruthy();
  });

  it('a finished request\'s deep link opens Updates', async () => {
    store.notifications = [request('open'), finished('done', 'approved')];
    renderAt('/inbox?notification=done');
    await vi.waitFor(() => expect(card('done')).toBeTruthy(), SLOW);
    expect(card('open')).toBeNull();
  });
});
