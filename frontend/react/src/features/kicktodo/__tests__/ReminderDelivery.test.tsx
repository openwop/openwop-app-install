/**
 * ADR 0443 R1 / ADR 0421 regression net — a daypart reminder can actually leave
 * the app.
 *
 * Found on kicktodo.com 2026-09-17: `routeReminder` refuses without the
 * `messaging-reminders` consent, and no surface could grant it. The Today page
 * told participants to allow it "in your integration consents", a screen that
 * does not exist, so every scheduled reminder stayed in the app. These pin:
 *  - no consent → the one gesture subscribes this device FIRST (inside the click's
 *    user activation) and THEN grants the consent;
 *  - consent + a subscribed device → says so, and Stop revokes the consent;
 *  - consent without a device subscription → says the inbox, offers the device;
 *  - a failed consent read is stated and never offers a grant it cannot back;
 *  - a REFUSED subscribe (ADR 0816 NTFUX-2) is a stated failure and grants nothing.
 * PT-3 adds: the read in flight is stated (never a blank), a failed read has a
 * Retry that re-reads, a THROWN device subscribe is a stated failure (not an
 * unhandled rejection), and only the in-flight button reports aria-busy.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import type { useNotificationStore } from '../../../notifications/notificationStore.js';
import type { IntegrationConsent } from '../../../client/kicktodoIntegrationsClient.js';

type NotificationStore = ReturnType<typeof useNotificationStore.getState>;
type StoreSlice = Pick<NotificationStore, 'pushStatus' | 'syncPushStatus' | 'enablePush'>;

const calls: string[] = [];
const store: StoreSlice = {
  pushStatus: 'available',
  syncPushStatus: vi.fn(async () => {}),
  enablePush: vi.fn(async () => { calls.push('enablePush'); store.pushStatus = 'subscribed'; return true; }),
};
vi.mock('../../../notifications/notificationStore.js', () => ({
  useNotificationStore: <T,>(sel: (s: StoreSlice) => T): T => sel(store),
}));

let consents: IntegrationConsent[] = [];
vi.mock('../../../client/kicktodoIntegrationsClient.js', () => ({
  getConsents: vi.fn(async () => consents),
  grantConsent: vi.fn(async (kind: string) => { calls.push(`grant:${kind}`); consents = [{ kind, grantedAt: '2026-09-17T00:00:00Z' }]; }),
  revokeConsent: vi.fn(async (kind: string) => { calls.push(`revoke:${kind}`); consents = [{ kind, grantedAt: '2026-09-16T00:00:00Z', revokedAt: '2026-09-17T00:00:00Z' }]; }),
}));

import { ReminderDelivery } from '../ReminderDelivery.js';
import { getConsents } from '../../../client/kicktodoIntegrationsClient.js';
import { messages as en } from '../i18n/en.js';

beforeEach(() => {
  calls.length = 0;
  consents = [];
  store.pushStatus = 'available';
  vi.mocked(getConsents).mockImplementation(async () => consents);
});
afterEach(cleanup);

describe('ReminderDelivery (ADR 0443 R1)', () => {
  it('no consent: one gesture subscribes this device, THEN grants messaging-reminders', async () => {
    render(<ReminderDelivery />);
    fireEvent.click(await screen.findByRole('button', { name: 'Allow reminders' }));
    await waitFor(() => screen.getByText('Reminders reach this device'));
    expect(calls).toEqual(['enablePush', 'grant:messaging-reminders']);
  });

  it('consent and a subscribed device: says so, and Stop revokes the consent', async () => {
    consents = [{ kind: 'messaging-reminders', grantedAt: '2026-09-16T00:00:00Z' }];
    store.pushStatus = 'subscribed';
    render(<ReminderDelivery />);
    await waitFor(() => screen.getByText('Reminders reach this device'));
    expect(screen.queryByRole('button', { name: 'Allow reminders' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop reminders' }));
    await waitFor(() => screen.getByRole('button', { name: 'Allow reminders' }));
    expect(calls).toEqual(['revoke:messaging-reminders']);
  });

  it('consent without a device subscription: names the inbox and offers this device', async () => {
    consents = [{ kind: 'messaging-reminders', grantedAt: '2026-09-16T00:00:00Z' }];
    render(<ReminderDelivery />);
    await waitFor(() => screen.getByText('Reminders show in your notifications inbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Also send to this device' }));
    await waitFor(() => expect(calls).toEqual(['enablePush']));
    await waitFor(() => screen.getByText('Reminders reach this device'));
  });

  it('a refused device subscription is a failure, never a consent (ADR 0816 NTFUX-2)', async () => {
    vi.mocked(store.enablePush).mockImplementationOnce(async () => { calls.push('enablePush'); return false; });
    render(<ReminderDelivery />);
    fireEvent.click(await screen.findByRole('button', { name: 'Allow reminders' }));
    expect(await screen.findByText('Couldn’t update reminders. Try again.')).toBeTruthy();
    expect(calls).toEqual(['enablePush']);
    expect(screen.getByRole('button', { name: 'Allow reminders' })).toBeTruthy();
  });

  it('a revoked consent is not a consent', async () => {
    consents = [{ kind: 'messaging-reminders', grantedAt: '2026-09-15T00:00:00Z', revokedAt: '2026-09-16T00:00:00Z' }];
    render(<ReminderDelivery />);
    expect(await screen.findByRole('button', { name: 'Allow reminders' })).toBeTruthy();
  });

  it('a failed consent read is stated and offers no grant it cannot back', async () => {
    vi.mocked(getConsents).mockRejectedValueOnce(new Error('503'));
    render(<ReminderDelivery />);
    await waitFor(() => screen.getByText('Couldn’t check where reminders go'));
    expect(screen.queryByRole('button', { name: 'Allow reminders' })).toBeNull();
  });

  it('PT-3: the consent read in flight is stated, not rendered as nothing', async () => {
    let release!: () => void;
    vi.mocked(getConsents).mockImplementationOnce(() => new Promise((r) => { release = () => r(consents); }));
    render(<ReminderDelivery />);
    expect(screen.getByText(en.reminderDelivery_checking)).toBeTruthy();
    release();
    expect(await screen.findByRole('button', { name: en.reminderDelivery_allow })).toBeTruthy();
    expect(screen.queryByText(en.reminderDelivery_checking)).toBeNull();
  });

  it('PT-3: a failed consent read offers a Retry that re-reads', async () => {
    vi.mocked(getConsents).mockRejectedValueOnce(new Error('503'));
    render(<ReminderDelivery />);
    await waitFor(() => screen.getByText(en.reminderDelivery_unavailable));
    const before = vi.mocked(getConsents).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: en.reminderDelivery_allow })).toBeTruthy();
    expect(vi.mocked(getConsents).mock.calls.length).toBe(before + 1);
  });

  it('PT-3: a THROWN device subscribe is a stated failure, never an unhandled rejection', async () => {
    consents = [{ kind: 'messaging-reminders', grantedAt: '2026-09-16T00:00:00Z' }];
    vi.mocked(store.enablePush).mockImplementationOnce(async () => { throw new Error('push service down'); });
    render(<ReminderDelivery />);
    fireEvent.click(await screen.findByRole('button', { name: en.reminderDelivery_addDevice }));
    expect(await screen.findByText(en.reminderDelivery_actionError)).toBeTruthy();
    // The button is usable again, not stuck busy.
    expect((screen.getByRole('button', { name: en.reminderDelivery_addDevice }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('PT-3: only the in-flight button reports aria-busy', async () => {
    consents = [{ kind: 'messaging-reminders', grantedAt: '2026-09-16T00:00:00Z' }];
    let finish!: () => void;
    vi.mocked(store.enablePush).mockImplementationOnce(() => new Promise<boolean>((r) => { finish = () => r(true); }));
    render(<ReminderDelivery />);
    fireEvent.click(await screen.findByRole('button', { name: en.reminderDelivery_addDevice }));
    await waitFor(() => expect(screen.getByRole('button', { name: en.reminderDelivery_addDevice }).getAttribute('aria-busy')).toBe('true'));
    expect(screen.getByRole('button', { name: en.reminderDelivery_stop }).getAttribute('aria-busy')).toBeNull();
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: en.reminderDelivery_addDevice }).getAttribute('aria-busy')).toBeNull());
  });
});
