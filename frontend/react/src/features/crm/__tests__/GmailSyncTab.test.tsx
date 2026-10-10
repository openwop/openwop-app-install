/**
 * GmailSyncTab designed states (ADR 0252 P3) — the "connect Google first"
 * StateCard renders when the caller has no google connection, the ADR 0252 §1
 * privacy Notice always renders, a failed read is the canonical announced card
 * (CRM-UX-4/14) and never also the empty state, and create / toggle / delete /
 * sync-now each round-trip through the client + surface a toast. Mocks
 * `gmailSyncClient.js` + `connectionsClient.js` at the module level (the
 * ReportsTab.test.tsx / CrmPage.test.tsx precedent in this feature).
 *
 * Sabotage that turns it red (wave-4 /grade-tests probes): the privacy notice
 * removed; the google-provider filter dropped; create/toggle/sync-now sending
 * the wrong arguments; a declined-confirm guard inverted; the empty state
 * rendered beside the failure card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from '../../../ui/toast.js';
// Type-only (erased at runtime, so it does not race `vi.mock`).
import type * as ConnectionsClient from '../../connections/connectionsClient.js';
import type * as GmailClient from '../gmailSyncClient.js';
import type { Connection } from '../../connections/connectionsClient.js';
import type { GmailSync } from '../gmailSyncClient.js';

const GOOGLE_CONN: Connection = { connectionId: 'conn-g1', provider: 'google', kind: 'oauth2', displayName: 'ada@example.com', status: 'connected', scopes: [], connectedAt: '2026-06-01T00:00:00.000Z', userId: 'user-1' };
const OTHER_CONN: Connection = { connectionId: 'conn-s1', provider: 'slack', kind: 'oauth2', displayName: 'Team Slack', status: 'connected', scopes: [], connectedAt: '2026-06-01T00:00:00.000Z', userId: 'user-1' };

const listConnections = vi.hoisted(() => vi.fn<typeof ConnectionsClient.listConnections>());
vi.mock('../../connections/connectionsClient.js', () => ({ listConnections }));

const SYNC: GmailSync = {
  syncId: 'gmailsync:1',
  tenantId: 't1',
  orgId: 'o1',
  userId: 'user-1',
  connectionId: 'conn-g1',
  cadence: 'daily',
  jobId: 'gmailsync:gmailsync:1',
  status: 'active',
  lastSyncedAt: '2026-07-03T12:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

const listGmailSyncs = vi.hoisted(() => vi.fn<typeof GmailClient.listGmailSyncs>());
const createGmailSync = vi.hoisted(() => vi.fn<typeof GmailClient.createGmailSync>());
const updateGmailSync = vi.hoisted(() => vi.fn<typeof GmailClient.updateGmailSync>());
const deleteGmailSync = vi.hoisted(() => vi.fn<typeof GmailClient.deleteGmailSync>());
const syncGmailNow = vi.hoisted(() => vi.fn<typeof GmailClient.syncGmailNow>());
vi.mock('../gmailSyncClient.js', () => ({
  GMAIL_SYNC_CADENCES: ['15m', 'hourly', 'daily'],
  listGmailSyncs,
  createGmailSync,
  updateGmailSync,
  deleteGmailSync,
  syncGmailNow,
}));

import { GmailSyncTab } from '../GmailSyncTab.js';

const renderTab = (orgId = 'o1') => render(
  <MemoryRouter><GmailSyncTab orgId={orgId} /><Toaster /></MemoryRouter>,
);

beforeEach(() => {
  vi.resetAllMocks();
  listConnections.mockResolvedValue([GOOGLE_CONN, OTHER_CONN]);
  listGmailSyncs.mockResolvedValue([SYNC]);
  createGmailSync.mockResolvedValue({ ...SYNC, syncId: 'gmailsync:new' });
  updateGmailSync.mockResolvedValue({ ...SYNC, status: 'paused' });
  deleteGmailSync.mockResolvedValue(undefined);
  syncGmailNow.mockResolvedValue({ runId: 'run-1' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('GmailSyncTab designed states', () => {
  it('loading: renders the privacy notice immediately, before the fetch settles', () => {
    renderTab();
    expect(screen.getByText(/records only that an email was exchanged/)).toBeTruthy();
  });

  it('empty (no google connection): renders the "connect Google first" StateCard instead of the create form', async () => {
    listConnections.mockResolvedValue([OTHER_CONN]);
    renderTab();
    expect(await screen.findByText('Connect Google first')).toBeTruthy();
    expect(screen.getByText('Manage connections')).toBeTruthy();
    expect(screen.queryByLabelText('Gmail connection')).toBeNull();
  });

  it('empty (no syncs yet): renders the designed StateCard naming the next action', async () => {
    listGmailSyncs.mockResolvedValue([]);
    renderTab();
    expect(await screen.findByText('No Gmail syncs yet')).toBeTruthy();
  });

  it('list: renders the connection label, cadence, status, and last-synced', async () => {
    renderTab();
    // "ada@example.com" and "Daily" also appear in the create-form's pickers.
    await waitFor(() => expect(screen.getAllByText('ada@example.com').length).toBeGreaterThan(1));
    expect(screen.getAllByText('Daily').length).toBeGreaterThan(1);
    expect(screen.getByRole('button', { name: /Toggle Gmail sync for ada@example.com/ }).textContent).toBe('Active');
    // last-synced: the row HAS a timestamp, so it must not read "Not synced yet".
    // (The relative text itself is clock-derived and deliberately not pinned.)
    expect(screen.queryByText('Not synced yet')).toBeNull();
  });

  it('create: submits the form, calls createGmailSync, and toasts success', async () => {
    renderTab();
    await waitFor(() => expect(listGmailSyncs).toHaveBeenCalled());

    // The submit is disabled until listConnections resolves and defaults the
    // connection — wait for that before clicking (else the click is a no-op).
    await waitFor(() => expect((screen.getByRole('button', { name: /Enable sync/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Enable sync/ }));

    await waitFor(() => expect(createGmailSync).toHaveBeenCalledWith({ orgId: 'o1', connectionId: 'conn-g1', cadence: 'daily' }));
    expect(await screen.findByText('Gmail sync enabled.')).toBeTruthy();
  });

  it('toggle: flips status via updateGmailSync and toasts the new state', async () => {
    renderTab();
    await waitFor(() => expect(listGmailSyncs).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /Toggle Gmail sync for ada@example.com/ }));

    await waitFor(() => expect(updateGmailSync).toHaveBeenCalledWith('gmailsync:1', { status: 'paused' }));
    expect(await screen.findByText('Gmail sync for ada@example.com paused.')).toBeTruthy();
  });

  it('sync-now: calls syncGmailNow and toasts', async () => {
    renderTab();
    await waitFor(() => expect(listGmailSyncs).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /Sync now for ada@example.com/ }));

    await waitFor(() => expect(syncGmailNow).toHaveBeenCalledWith('gmailsync:1'));
    expect(await screen.findByText('Sync started.')).toBeTruthy();
  });

  it('delete: confirms, deletes, and toasts success', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderTab();
    await waitFor(() => expect(listGmailSyncs).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /Remove Gmail sync for ada@example.com/ }));

    await waitFor(() => expect(deleteGmailSync).toHaveBeenCalledWith('gmailsync:1'));
    expect(await screen.findByText('Gmail sync removed.')).toBeTruthy();
  });

  it('a load failure lands the canonical announced failed-read card + Retry (not a stranded skeleton, a contradictory empty state, or the wire string)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listGmailSyncs.mockRejectedValueOnce(new Error('gmail sync boom'));
    renderTab();
    // CRM-UX-14 — the shared `common:` copy; the transport's words go to
    // console.warn and nowhere the user can see.
    expect(await screen.findByText('Could not load this')).toBeTruthy();
    expect(screen.queryByText(/gmail sync boom/)).toBeNull();
    expect(warn).toHaveBeenCalled();
    // The card owns the failure — the success-toned empty state must NOT also show.
    expect(screen.queryByText('No Gmail syncs yet')).toBeNull();
    // ...and recovery is offered inline.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
