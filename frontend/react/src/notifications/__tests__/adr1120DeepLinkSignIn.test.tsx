/**
 * ADR 1120 — an emailed Review link (`/inbox?notification=<id>`) opened while signed
 * out offers sign-in and remembers the exact URL, so the person comes back to the
 * request. Signed in, there is no prompt, and a remembered return is followed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { useNotificationStore as RealStore } from '../notificationStore.js';

type StoreState = ReturnType<typeof RealStore.getState>;
const storeState: Partial<StoreState> = {
  notifications: [], unreadCount: 0, loading: false, error: null,
  refresh: vi.fn(), markAllRead: vi.fn(), markAsRead: vi.fn(), markAsUnread: vi.fn(), archive: vi.fn(), delete: vi.fn(),
} as Partial<StoreState>;
vi.mock('../notificationStore.js', () => ({
  useNotificationStore: (sel?: (s: Partial<StoreState>) => unknown) => (sel ? sel(storeState) : storeState),
}));
vi.mock('../../client/interruptsClient.js', () => ({ listOpenInterrupts: async () => [] }));
vi.mock('../NeedsYouInbox.js', () => ({ NeedsYouInbox: () => null }));
vi.mock('../DelegationSection.js', () => ({ DelegationSection: () => null }));
vi.mock('../TeamsDeliverySection.js', () => ({ TeamsDeliverySection: () => null }));

const auth = vi.hoisted(() => ({ user: null as null | { uid: string } }));
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock('../../auth/backendSession.js', () => ({ useBackendSession: () => ({ user: null }) }));
const ret = vi.hoisted(() => ({ remembered: [] as string[], opened: 0, pending: null as string | null }));
vi.mock('../../auth/signInReturn.js', () => ({
  rememberReturn: (url: string) => { ret.remembered.push(url); },
  openHeaderSignIn: () => { ret.opened += 1; return true; },
  takeReturn: () => { const v = ret.pending; ret.pending = null; return v; },
}));

const { NotificationsPage } = await import('../NotificationsPage.js');

afterEach(() => { cleanup(); vi.clearAllMocks(); ret.remembered.length = 0; ret.opened = 0; auth.user = null; });

describe('ADR 1120 — a Review link opened signed out', () => {
  it('offers sign-in and remembers the exact deep link', () => {
    window.history.replaceState({}, '', '/inbox?notification=n-42');
    render(<MemoryRouter initialEntries={['/inbox?notification=n-42']}><NotificationsPage /></MemoryRouter>);
    expect(screen.getByText('Sign in to review this request.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(ret.remembered).toEqual(['/inbox?notification=n-42']);
    expect(ret.opened).toBe(1);
  });

  it('shows no prompt without a deep link, or once signed in', () => {
    render(<MemoryRouter initialEntries={['/inbox']}><NotificationsPage /></MemoryRouter>);
    expect(screen.queryByText('Sign in to review this request.')).toBeNull();
    cleanup();
    auth.user = { uid: 'u-1' };
    render(<MemoryRouter initialEntries={['/inbox?notification=n-42']}><NotificationsPage /></MemoryRouter>);
    expect(screen.queryByText('Sign in to review this request.')).toBeNull();
  });
});
