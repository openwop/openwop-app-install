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
 *  - a failed consent read is stated and never offers a grant it cannot back.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const calls: string[] = [];
const store = {
  pushStatus: 'available' as 'unsupported' | 'disabled' | 'available' | 'subscribed' | 'unknown',
  syncPushStatus: vi.fn(async () => {}),
  enablePush: vi.fn(async () => { calls.push('enablePush'); store.pushStatus = 'subscribed'; return true; }),
};
vi.mock('../../../notifications/notificationStore.js', () => ({
  useNotificationStore: <T,>(sel: (s: typeof store) => T): T => sel(store),
}));

let consents: Array<{ kind: string; revokedAt?: string }> = [];
vi.mock('../../../client/kicktodoIntegrationsClient.js', () => ({
  getConsents: vi.fn(async () => consents),
  grantConsent: vi.fn(async (kind: string) => { calls.push(`grant:${kind}`); consents = [{ kind }]; }),
  revokeConsent: vi.fn(async (kind: string) => { calls.push(`revoke:${kind}`); consents = [{ kind, revokedAt: '2026-09-17T00:00:00Z' }]; }),
}));

import { ReminderDelivery } from '../ReminderDelivery.js';
import { getConsents } from '../../../client/kicktodoIntegrationsClient.js';

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
    consents = [{ kind: 'messaging-reminders' }];
    store.pushStatus = 'subscribed';
    render(<ReminderDelivery />);
    await waitFor(() => screen.getByText('Reminders reach this device'));
    expect(screen.queryByRole('button', { name: 'Allow reminders' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop reminders' }));
    await waitFor(() => screen.getByRole('button', { name: 'Allow reminders' }));
    expect(calls).toEqual(['revoke:messaging-reminders']);
  });

  it('consent without a device subscription: names the inbox and offers this device', async () => {
    consents = [{ kind: 'messaging-reminders' }];
    render(<ReminderDelivery />);
    await waitFor(() => screen.getByText('Reminders show in your notifications inbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Also send to this device' }));
    await waitFor(() => expect(calls).toEqual(['enablePush']));
  });

  it('a revoked consent is not a consent', async () => {
    consents = [{ kind: 'messaging-reminders', revokedAt: '2026-09-16T00:00:00Z' }];
    render(<ReminderDelivery />);
    expect(await screen.findByRole('button', { name: 'Allow reminders' })).toBeTruthy();
  });

  it('a failed consent read is stated and offers no grant it cannot back', async () => {
    vi.mocked(getConsents).mockRejectedValueOnce(new Error('503'));
    render(<ReminderDelivery />);
    await waitFor(() => screen.getByText('Couldn’t check where reminders go'));
    expect(screen.queryByRole('button', { name: 'Allow reminders' })).toBeNull();
  });
});
