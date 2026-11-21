/**
 * UX_UPGRADE-inbox IB-G1 — the priority filter.
 *
 * Every notification already carried a `priority` and the page never used it.
 * The behaviours worth pinning are the restraint ones: the toggle appears only
 * when it would actually change the list, and it narrows WITHIN the active tab
 * rather than across it — the tab counts must keep meaning what they say.
 *
 * Also here: R2 IB-SP-9 (a failed first read is not "all clear"), IB-SP-2 (the
 * stale notice) and IB-R2-1 (the j/k/e/u/Enter queue grammar, with ADR 1125 D3:
 * `e` skips an open request). The `e` guard cases (dialog, input) run on NEWS rows
 * in Updates, because an open request is ALSO refused by the D3 skip, which would
 * hide a removed dialog/input guard. Fixed `createdAt`; no clock reads.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Notification } from '../types.js';
import type { useNotificationStore as RealStore } from '../notificationStore.js';

type StoreState = ReturnType<typeof RealStore.getState>;

// The real hook is SELECTOR-based (`useNotificationStore((s) => s.notifications)`),
// so the mock must apply the selector rather than hand back the whole state.
let storeState: Partial<StoreState> = {};
vi.mock('../notificationStore.js', () => ({
  useNotificationStore: (sel?: (s: Partial<StoreState>) => unknown) => (sel ? sel(storeState) : storeState),
}));
vi.mock('../../client/interruptsClient.js', () => ({ listOpenInterrupts: async () => [] }));
vi.mock('../NeedsYouInbox.js', () => ({ NeedsYouInbox: () => null }));
vi.mock('../DelegationSection.js', () => ({ DelegationSection: () => null }));
vi.mock('../TeamsDeliverySection.js', () => ({ TeamsDeliverySection: () => null }));

const { NotificationsPage } = await import('../NotificationsPage.js');

const note = (id: string, priority: Notification['priority'], title: string): Notification => ({
  notificationId: id,
  type: 'openwop-app.workflow.approval-needed',
  priority,
  status: 'unread',
  title,
  message: `${title} body`,
  createdAt: '2026-07-24T09:00:00.000Z',
});

function withNotifications(list: Notification[]): void {
  storeState = ({
    notifications: list,
    unreadCount: list.filter((n) => n.status === 'unread').length,
    loading: false,
    error: null,
    refresh: vi.fn(),
    markAllRead: vi.fn(),
    // REAL store action names (review F13: `markRead`/`remove` never existed
    // on the store — the page ran with undefined actions and nothing noticed).
    markAsRead: vi.fn(),
    markAsUnread: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
  });
}

const renderInbox = () => render(<MemoryRouter><NotificationsPage /></MemoryRouter>);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('inbox — priority filter (IB-G1)', () => {
  it('narrows to urgent + high, and restores', async () => {
    withNotifications([
      note('n1', 'urgent', 'Server on fire'),
      note('n2', 'high', 'Budget nearly spent'),
      note('n3', 'normal', 'Weekly digest'),
      note('n4', 'low', 'FYI'),
    ]);
    renderInbox();

    await screen.findByText('Weekly digest');
    // fireEvent runs inside act(), so the filtered list is committed when it returns:
    // every check below is synchronous and fails on the list, not on a timeout.
    fireEvent.click(screen.getByRole('button', { name: /urgent & high \(2\)/i }));

    expect(screen.queryByText('Weekly digest')).toBeNull();
    expect(screen.getByText('Server on fire')).toBeTruthy();
    expect(screen.getByText('Budget nearly spent')).toBeTruthy();
    expect(screen.queryByText('FYI')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /urgent & high/i }));
    expect(screen.getByText('Weekly digest')).toBeTruthy();
    expect(screen.getByText('FYI')).toBeTruthy();
  });

  it('reports its own state via aria-pressed and a live count', async () => {
    withNotifications([note('n1', 'urgent', 'A'), note('n2', 'normal', 'B'), note('n3', 'low', 'C')]);
    renderInbox();
    const toggle = await screen.findByRole('button', { name: /urgent & high/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/showing 1 of 3/i)).toBeTruthy();
  });

  it('is NOT offered when every notification is already urgent — it would do nothing', async () => {
    withNotifications([note('n1', 'urgent', 'A'), note('n2', 'high', 'B')]);
    renderInbox();
    await screen.findByText('A');
    expect(screen.queryByRole('button', { name: /urgent & high/i })).toBeNull();
  });

  it('is NOT offered when nothing is urgent', async () => {
    withNotifications([note('n1', 'normal', 'A'), note('n2', 'low', 'B')]);
    renderInbox();
    await screen.findByText('A');
    expect(screen.queryByRole('button', { name: /urgent & high/i })).toBeNull();
  });

  it('does not count ARCHIVED items into the urgent tally of the open tabs', async () => {
    const archived: Notification = { ...note('n9', 'urgent', 'Old fire'), status: 'archived' };
    withNotifications([note('n1', 'normal', 'A'), note('n2', 'low', 'B'), archived]);
    renderInbox();
    await screen.findByText('A');
    // The default tab excludes archived, so an archived urgent must not make
    // the toggle appear over a queue that has nothing urgent in it.
    expect(screen.queryByRole('button', { name: /urgent & high/i })).toBeNull();
  });
});

describe('R2 IB-SP-9 — a failed FIRST read is not "all clear" under a 0/0/0 band', () => {
  it('error + empty list: no key-figure band, no empty-state claim, localized copy + retry', async () => {
    withNotifications([]);
    storeState = { ...storeState, error: '/host/openwop-app/notifications → 500', connectionStatus: 'connected' };
    renderInbox();
    // Settle on the Retry (it renders whatever the copy says), then read the copy:
    // the localized failure copy renders; the RAW endpoint path never does.
    await screen.findByRole('button', { name: /retry/i });
    expect(screen.getByText(/couldn.t be loaded/i)).toBeTruthy();
    // Matches the canonical root, with `/v1` optional. The fixture above now
    // seeds a `/host/openwop-app/…` error string, so asserting only on
    // `/v1/host` would have passed because the text it looks for no longer
    // exists anywhere — true for the wrong reason, and silently so.
    expect(screen.queryByText(/(?:\/v1)?\/host\/openwop-app/)).toBeNull();
    // No "you're all clear" claim, no 0/0/0 band asserting facts a failed
    // read cannot know. ADR 1125 P3 renamed both: the empty state now reads
    // "Nothing needs you right now." and the band's first figure "Needs you", so
    // the old `/all clear/` and `/action needed/` matchers matched nothing at all
    // and could not fail. The old words stay in the pattern as a superset.
    expect(screen.queryByText(/nothing needs you|all clear|no notifications yet/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /needs you|action needed/i })).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('error with data still on screen keeps the band (a mutation failure must not hide the list)', async () => {
    withNotifications([note('n1', 'normal', 'Still here')]);
    storeState = { ...storeState, error: 'archive → 500', connectionStatus: 'connected' };
    renderInbox();
    await screen.findByText('Still here');
    expect(screen.getByText(/didn.t go through/i)).toBeTruthy();
    // The band stays: a mutation failure must not hide the key figures.
    expect(screen.getByRole('button', { name: /needs you/i })).toBeTruthy();
  });
});

describe('R2 IB-SP-2 — the page-level stale notice', () => {
  it('renders when connectionStatus is error, absent when connected', async () => {
    withNotifications([note('n1', 'normal', 'Row')]);
    storeState = { ...storeState, connectionStatus: 'error' };
    renderInbox();
    await screen.findByText('Row');
    expect(screen.getByText(/live updates are interrupted/i)).toBeTruthy();
    cleanup();
    withNotifications([note('n1', 'normal', 'Row')]);
    storeState = { ...storeState, connectionStatus: 'connected' };
    renderInbox();
    await screen.findByText('Row');
    expect(screen.queryByText(/live updates are interrupted/i)).toBeNull();
  });
});


describe('inbox — keyboard queue nav (IB-R2-1, first tests: review F13)', () => {
  const kd = (key: string): void => { fireEvent.keyDown(window, { key }); };
  const cursorOn = (id: string): string => document.querySelector(`[data-notification-id="${id}"]`)!.className;
  // ADR 1125 D3 — `e` archives news; an open request is skipped. A news row sits on Updates.
  const newsRow = (id: string, title: string): Notification => ({ ...note(id, 'normal', title), type: 'workflow.completed' });

  it('j moves the cursor down, k back up (cursor class follows)', async () => {
    withNotifications([note('n1', 'normal', 'First'), note('n2', 'normal', 'Second')]);
    renderInbox();
    await screen.findByText('First');
    kd('j');
    expect(document.querySelector('[data-notification-id="n1"]')!.className).toContain('notifpage-card--cursor');
    kd('j');
    expect(document.querySelector('[data-notification-id="n2"]')!.className).toContain('notifpage-card--cursor');
    kd('k');
    expect(document.querySelector('[data-notification-id="n1"]')!.className).toContain('notifpage-card--cursor');
  });

  it('e archives the cursor row through the store action', async () => {
    // News rows: an open request is skipped by `e` (next case).
    withNotifications([newsRow('n1', 'First'), newsRow('n2', 'Second')]);
    renderInbox();
    fireEvent.click(screen.getByRole('button', { name: /^Updates/ }));
    await screen.findByText('First');
    // Cursor on the SECOND row, so "the cursor row" differs from "the first row".
    kd('j');
    kd('j');
    kd('e');
    expect(storeState.archive).toHaveBeenCalledWith('n2');
  });

  it('e skips an open request: it still waits on someone (ADR 1125 D3)', async () => {
    withNotifications([note('n1', 'normal', 'First'), note('n2', 'normal', 'Second')]);
    renderInbox();
    await screen.findByText('First');
    kd('j');
    kd('j');
    // Positive control: the cursor IS on a row, so only the D3 skip can stop `e`.
    expect(cursorOn('n2')).toContain('notifpage-card--cursor');
    kd('e');
    expect(storeState.archive).not.toHaveBeenCalled();
  });

  it('u marks the unread cursor row read', async () => {
    withNotifications([note('n1', 'normal', 'First')]);
    renderInbox();
    await screen.findByText('First');
    kd('j');
    kd('u');
    expect(storeState.markAsRead).toHaveBeenCalledWith('n1');
  });

  it('the grammar DISARMS under an open dialog (review F5 — no mutation behind a modal)', async () => {
    // A NEWS row: an open request would also be refused by the D3 skip.
    withNotifications([newsRow('n1', 'First')]);
    renderInbox();
    fireEvent.click(screen.getByRole('button', { name: /^Updates/ }));
    await screen.findByText('First');
    kd('j');
    expect(cursorOn('n1')).toContain('notifpage-card--cursor');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    try {
      kd('e');
      expect(storeState.archive).not.toHaveBeenCalled();
    } finally { dialog.remove(); }
  });

  it('typing in an input never drives the queue (the INPUT guard)', async () => {
    // NEWS rows: an open request would also be refused by the D3 skip.
    withNotifications([newsRow('n1', 'First'), newsRow('n2', 'Second')]);
    renderInbox();
    fireEvent.click(screen.getByRole('button', { name: /^Updates/ }));
    await screen.findByText('First');
    kd('j');
    expect(cursorOn('n1')).toContain('notifpage-card--cursor');
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      fireEvent.keyDown(input, { key: 'e' });
      expect(storeState.archive).not.toHaveBeenCalled();
    } finally { input.remove(); }
  });

  it('Enter navigates to the cursor row\'s action URL and marks it read', async () => {
    const rows: Notification[] = [{ ...note('n1', 'normal', 'First'), actionUrl: '/runs/r1' }];
    withNotifications(rows);
    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <Routes>
          <Route path="/inbox" element={<NotificationsPage />} />
          <Route path="/runs/:runId" element={<p>run page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('First');
    kd('j');
    kd('Enter');
    expect(storeState.markAsRead).toHaveBeenCalledWith('n1');
    await screen.findByText('run page');
  });

  it('Enter with no action URL does nothing (no false navigation)', async () => {
    withNotifications([note('n1', 'normal', 'First')]);
    renderInbox();
    await screen.findByText('First');
    kd('j');
    kd('Enter');
    expect(storeState.markAsRead).not.toHaveBeenCalled();
  });
});
