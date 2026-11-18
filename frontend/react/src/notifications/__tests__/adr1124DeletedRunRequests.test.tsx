/**
 * ADR 1124 D3 — a request card whose run cannot be opened says so plainly.
 *
 * A 404 from the open-interrupts read means the run is gone, or (ADR 1121) it is
 * a client run this person may not read. The card never claims which. Any other
 * failure keeps "couldn't be loaded". A row stamped `run-deleted` shows that
 * ending and no link to a run that no longer exists.
 *
 * Sabotage witness: drop the 404 branch in `InlineInterruptResolver` and the
 * first case reads "This approval couldn't be loaded" instead.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { useNotificationStore as RealStore } from '../notificationStore.js';
import type { Notification } from '../types.js';
import { ApiError } from '../../client/requestJson.js';
import { messages as en } from '../i18n/en.js';

type StoreState = ReturnType<typeof RealStore.getState>;
const store = vi.hoisted(() => ({ notifications: [] as unknown[] }));
const storeState = (): Partial<StoreState> => ({
  notifications: store.notifications, unreadCount: store.notifications.length, loading: false, error: null,
  refresh: vi.fn(), markAllRead: vi.fn(), markAsRead: vi.fn(), markAsUnread: vi.fn(), archive: vi.fn(), delete: vi.fn(),
} as Partial<StoreState>);
vi.mock('../notificationStore.js', () => ({
  useNotificationStore: (sel?: (s: Partial<StoreState>) => unknown) => (sel ? sel(storeState()) : storeState()),
}));
const listOpenInterrupts = vi.hoisted(() => vi.fn());
vi.mock('../../client/interruptsClient.js', () => ({ listOpenInterrupts }));
vi.mock('../NeedsYouInbox.js', () => ({ NeedsYouInbox: () => null }));
vi.mock('../DelegationSection.js', () => ({ DelegationSection: () => null }));
vi.mock('../TeamsDeliverySection.js', () => ({ TeamsDeliverySection: () => null }));
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => ({ user: { uid: 'u-1' } }) }));
vi.mock('../../auth/backendSession.js', () => ({ useBackendSession: () => ({ user: null }) }));

const { NotificationsPage } = await import('../NotificationsPage.js');

// jsdom implements no scrolling; the deep-linked card scrolls itself into view.
Element.prototype.scrollIntoView = vi.fn();
afterEach(() => { cleanup(); vi.clearAllMocks(); store.notifications = []; window.history.replaceState({}, '', '/'); });

const request = (over: Partial<Notification> = {}): Notification => ({
  notificationId: 'n-1', tenantId: 't', type: 'openwop-app.workflow.approval-needed', priority: 'high', status: 'unread',
  title: 'Approval needed', message: 'Approve the brief', createdAt: new Date().toISOString(), runId: 'run-1', interruptId: 'i-1', ...over,
} as Notification);
const renderPage = () => render(<MemoryRouter initialEntries={['/inbox']}><NotificationsPage /></MemoryRouter>);

describe('ADR 1124 D3 — a card whose run cannot be opened', () => {
  it('a 404 reads "can no longer be opened here", not a load failure', async () => {
    store.notifications = [request()];
    listOpenInterrupts.mockRejectedValue(new ApiError({ status: 404, statusText: 'Not Found', url: '/x' }));
    renderPage();
    expect(await screen.findByText(en.interruptUnavailable)).toBeTruthy();
    expect(screen.queryByText(en.interruptLoadFailed)).toBeNull();
  });

  it('any other failure still says it could not be loaded', async () => {
    store.notifications = [request()];
    listOpenInterrupts.mockRejectedValue(new ApiError({ status: 500, statusText: 'Server Error', url: '/x' }));
    renderPage();
    expect(await screen.findByText(en.interruptLoadFailed)).toBeTruthy();
  });

  it('a run-deleted row shows that ending and no run link, and asks the server nothing', () => {
    store.notifications = [request({ status: 'read', metadata: { resolution: { state: 'run-deleted', at: '2026-11-15T00:00:00.000Z' } } })];
    // A finished request is not action-needed, so open it by deep link (its tab follows).
    window.history.replaceState({}, '', '/inbox?notification=n-1');
    render(<MemoryRouter initialEntries={['/inbox?notification=n-1']}><NotificationsPage /></MemoryRouter>);
    expect(screen.getByText(en.endRunDeleted)).toBeTruthy();
    expect(screen.queryByText(/Open the run/)).toBeNull();
    expect(listOpenInterrupts).not.toHaveBeenCalled();
  });
});
