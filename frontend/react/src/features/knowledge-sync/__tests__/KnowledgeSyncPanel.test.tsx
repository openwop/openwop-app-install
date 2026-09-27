/**
 * ADR 0107 Phase 5 — the KnowledgeSyncPanel. The client + connections + toast are
 * mocked. Covers: the feature-off self-hide, rendering the collection's sources,
 * adding a source, and "Sync now".
 *
 * The self-hide case used to be one test named "list rejects/404" — and that
 * conflation WAS the bug: `listSyncSources` rejected for 404 and for a server
 * failure alike, so the panel hid itself either way and a user whose Drive was
 * actively syncing was shown nothing. `null` now means 404 and only 404, so the
 * two are asserted separately below.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../knowledgeSyncClient.js', () => ({
  listSyncSources: vi.fn(), createSyncSource: vi.fn(), deleteSyncSource: vi.fn(),
  setSyncPaused: vi.fn(), setSyncIncludeMedia: vi.fn(), syncNow: vi.fn(),
}));
vi.mock('../../connections/connectionsClient.js', () => ({ listConnections: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn() }));

import { KnowledgeSyncPanel } from '../KnowledgeSyncPanel.js';
import { listSyncSources, createSyncSource, syncNow, setSyncIncludeMedia, setSyncPaused } from '../knowledgeSyncClient.js';
import { listConnections } from '../../connections/connectionsClient.js';
import { toast } from '../../../ui/toast.js';
import { confirm } from '../../../ui/confirm.js';

const mList = vi.mocked(listSyncSources);
const mCreate = vi.mocked(createSyncSource);
const mSync = vi.mocked(syncNow);
const mConns = vi.mocked(listConnections);
const mMedia = vi.mocked(setSyncIncludeMedia);
const mPaused = vi.mocked(setSyncPaused);
const mConfirm = vi.mocked(confirm);
const mToast = vi.mocked(toast);

const source = (over = {}) => ({ id: 's1', orgId: 'o1', connectionId: 'c1', provider: 'google', externalFolderId: 'FOLDER', collectionId: 'col1', cadence: 'daily', status: 'active', ...over } as never);

/**
 * A COMPLETE `SyncRunResult`, i.e. the shape the server actually returns.
 *
 * ADR 0605 R1 (review MEDIUM 6) — the old fixture omitted `skippedMedia`, and
 * the test stayed green because it asserted only the CALL, never the sentence.
 *
 * THE REVIEW'S STATED SYMPTOM WAS WRONG AND IS CORRECTED HERE. It said the copy
 * rendered *"…, undefined media skipped, …"*. MEASURED: i18next interpolates an
 * `undefined` value as the EMPTY STRING, so it rendered
 * `"Synced: 2 updated, 1 removed,  media skipped, 0 failed."` — a double space
 * and a missing number. The defect is real; the word "undefined" never appears,
 * which matters because an assertion written against the review's wording
 * (`not.toContain('undefined')`) is GREEN WITH THE FIXTURE BROKEN. That is what
 * the sabotage pass found, and it is why the assertion below is on the whole
 * sentence instead.
 */
const runResult = (over = {}) => ({ ingested: 2, pruned: 1, unchanged: 0, failed: 0, skippedMedia: 0, errors: [], ...over });

beforeEach(() => {
  mList.mockReset(); mCreate.mockReset(); mSync.mockReset(); mConns.mockReset();
  mMedia.mockReset(); mPaused.mockReset(); mConfirm.mockReset();
  mToast.success.mockReset(); mToast.error.mockReset(); mToast.warning.mockReset();
  mConns.mockResolvedValue([{ connectionId: 'c1', provider: 'google', displayName: 'My Drive' }] as never);
  mMedia.mockResolvedValue(undefined as never);
  mPaused.mockResolvedValue(undefined as never);
});
afterEach(cleanup);

describe('KnowledgeSyncPanel (ADR 0107)', () => {
  it('renders NOTHING when the feature is genuinely off (list resolves null = 404)', async () => {
    mList.mockResolvedValue(null as never);
    const { container } = render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(mList).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('.surface-card')).toBeNull());
  });

  it('a FAILED list keeps the panel and says so — it does not hide', async () => {
    // The regression this guards: hiding here told a user whose Drive may be
    // actively syncing that no sync exists. Absence is a claim; a failed read
    // is not entitled to make it.
    mList.mockRejectedValue(new Error('upstream unavailable'));
    const { container } = render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText(/Could not load this collection/i)).toBeTruthy());
    expect(container.querySelector('.surface-card')).not.toBeNull();
    expect(screen.getByText(/upstream unavailable/)).toBeTruthy();
  });

  it('a FAILED connections read does not tell you to connect an account', async () => {
    mList.mockResolvedValue([] as never);
    mConns.mockRejectedValue(new Error('conn read failed'));
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    // Settle on the panel heading, which renders in BOTH the fixed and the broken
    // state, so the absence check below is REACHED under sabotage. Waiting on the
    // error copy threw first, so the assertion this test exists for was never
    // evaluated — the file went red on the wait, not on the claim.
    await waitFor(() => expect(screen.getByText('Drive sync')).toBeTruthy());
    // The instructive empty state must NOT appear on a failed read — checked FIRST.
    expect(screen.queryByText(/Connect a Google Drive or OneDrive account first/i)).toBeNull();
    expect(screen.getByText(/Could not load your connected accounts/i)).toBeTruthy();
  });

  it('still shows the connect-an-account hint when the read SUCCEEDS with none', async () => {
    // The other arm — without this, the fix could degrade into "always error".
    mList.mockResolvedValue([] as never);
    mConns.mockResolvedValue([] as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText(/Connect a Google Drive or OneDrive account first/i)).toBeTruthy());
  });

  it('lists the collection’s sources and the add form', async () => {
    mList.mockResolvedValue([source(), source({ id: 's2', collectionId: 'OTHER' })] as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('Drive sync')).toBeTruthy());
    // only the col1 source shows (the OTHER-collection one is filtered out)
    expect(screen.getByText('FOLDER')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('My Drive')).toBeTruthy()); // connection option loaded
  });

  it('adds a sync source', async () => {
    mList.mockResolvedValue([] as never);
    mCreate.mockResolvedValue(source() as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('My Drive')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Drive account'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText('Folder ID'), { target: { value: 'FOLDER42' } });
    fireEvent.click(screen.getByRole('button', { name: /Add sync/ }));
    await waitFor(() => expect(mCreate).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'o1', collectionId: 'col1', connectionId: 'c1', externalFolderId: 'FOLDER42', provider: 'google', cadence: 'daily',
    })));
  });

  it('a Microsoft connection shows a Source selector; choosing SharePoint sends microsoft-sharepoint', async () => {
    mConns.mockResolvedValue([{ connectionId: 'ms', provider: 'microsoft-graph', displayName: 'Work 365' }] as never);
    mList.mockResolvedValue([] as never);
    mCreate.mockResolvedValue(source() as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('Work 365')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Drive account'), { target: { value: 'ms' } });
    // the OneDrive/SharePoint selector appears only for a Microsoft connection
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'sharepoint' } });
    fireEvent.change(screen.getByLabelText('Folder ID'), { target: { value: 'DRIVEID:ITEM' } });
    fireEvent.click(screen.getByRole('button', { name: /Add sync/ }));
    await waitFor(() => expect(mCreate).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'ms', provider: 'microsoft-sharepoint', externalFolderId: 'DRIVEID:ITEM',
    })));
  });

  it('runs "Sync now"', async () => {
    mList.mockResolvedValue([source()] as never);
    mSync.mockResolvedValue({ result: runResult(), source: source() } as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('FOLDER')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(mSync).toHaveBeenCalledWith('s1'));
    // …and the RESULT the user is shown is a COMPLETE sentence. With the old
    // fixture the media count rendered as an empty string ("…, 1 removed,
    // ␣media skipped, …") and nothing noticed, because nothing read the copy.
    await waitFor(() => expect(mToast.success).toHaveBeenCalled());
    expect(String(mToast.success.mock.calls[0]![0]))
      .toBe('Synced: 2 updated, 1 removed, 0 media skipped, 0 failed.');
  });
});

/**
 * ADR 0605 R1 (review MEDIUM 6) — THE WITNESSES `KSU-1`/`-2`/`-3`/`-4` WERE
 * CLOSED WITHOUT.
 *
 * This file was untouched by the Tier 6 diff and `grep pausedReason
 * backend/typescript/test/` returned zero, so four rows marked CLOSED rested on
 * no assertion at any layer — and review HIGH 3 (a failing pass UN-PAUSING a
 * paused source) is precisely what a `pausedReason` test would have caught.
 */
describe('ADR 0605 R1 — the Tier 6 deliverables, ratcheted', () => {
  it('KSU-1: a persisted lastRun renders what the last pass DID, including the deletions', async () => {
    mList.mockResolvedValue([source({
      lastRun: { at: '2026-08-20T10:00:00.000Z', ingested: 2, pruned: 3, unchanged: 5, failed: 1, skippedMedia: 4 },
    })] as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    // "3 removed" is the number this whole ADR is about; a scheduled pass used to
    // report it nowhere in the product.
    await waitFor(() => expect(screen.getByText(/2 updated, 3 removed, 4 media skipped, 1 failed/)).toBeTruthy());
  });

  it('KSU-2: a source that has never run says so, and one that has shows when', async () => {
    mList.mockResolvedValue([source()] as never);
    const { unmount } = render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText(/Never synced yet/i)).toBeTruthy());
    unmount();

    mList.mockResolvedValue([source({ lastSyncedAt: '2026-08-20T10:00:00.000Z' })] as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText(/Last synced /i)).toBeTruthy());
    expect(screen.queryByText(/Never synced yet/i)).toBeNull();
  });

  it('KSU-3: a REVOKED credential is not painted as a user pause', async () => {
    mList.mockResolvedValue([source({
      status: 'paused', pausedReason: 'connection-revoked', lastError: 'Connection revoked — reconnect to resume syncing.',
    })] as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('Reconnect needed')).toBeTruthy());
    expect(screen.queryByText('Paused')).toBeNull();
    // the reason is READABLE TEXT with a deep link, not a hover-only title
    expect(screen.getByText(/Connection revoked/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Reconnect this account/i }).getAttribute('href')).toBe('/access?tab=connections');
    // ADR 0605 R1 — Sync now is refused server-side here, so it is not offered…
    expect(screen.getByRole('button', { name: /Reconnect the account/i }).hasAttribute('disabled')).toBe(true);
    // …but RESUME IS AVAILABLE. Tier 6 disabled it, and with no
    // `onConnectionRestored` anywhere that left a revoked source permanently
    // paused with no in-product exit.
    const resume = screen.getByRole('button', { name: 'Resume' });
    expect(resume.hasAttribute('disabled')).toBe(false);
    fireEvent.click(resume);
    await waitFor(() => expect(mPaused).toHaveBeenCalledWith('s1', false));
  });

  it('KSU-3 (other arm): a pause the USER performed still reads as an ordinary pause', async () => {
    mList.mockResolvedValue([source({ status: 'paused', pausedReason: 'user' })] as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('Paused')).toBeTruthy());
    expect(screen.queryByText('Reconnect needed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync now' }).hasAttribute('disabled')).toBe(false);
  });

  it('KSU-4: turning media OFF confirms first, and a REFUSED confirm changes nothing', async () => {
    mList.mockResolvedValue([source()] as never); // includeMedia absent ⇒ on
    mConfirm.mockResolvedValue(false as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('FOLDER')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Media on/ }));
    await waitFor(() => expect(mConfirm).toHaveBeenCalled());
    // the confirm names the DELETION at the control that causes it
    expect(String(mConfirm.mock.calls[0]![0].body)).toMatch(/REMOVED from this collection/);
    expect(mConfirm.mock.calls[0]![0].danger).toBe(true);
    expect(mMedia).not.toHaveBeenCalled(); // refused ⇒ nothing was pruned
  });

  it('KSU-4 (other arm): turning media back ON is one click, correctly', async () => {
    mList.mockResolvedValue([source({ includeMedia: false })] as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('FOLDER')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Media off/ }));
    await waitFor(() => expect(mMedia).toHaveBeenCalledWith('s1', true));
    expect(mConfirm).not.toHaveBeenCalled(); // adding content is not destructive
  });

  it('KSU-17: a pass that DROPPED documents is not announced as a clean one', async () => {
    mList.mockResolvedValue([source()] as never);
    mSync.mockResolvedValue({ result: runResult({ failed: 3, errors: ['ingest x: boom'] }), source: source() } as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('FOLDER')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(mToast.warning).toHaveBeenCalled());
    expect(mToast.success).not.toHaveBeenCalled();
    expect(String(mToast.warning.mock.calls[0]![0])).toContain('ingest x: boom');
  });

  it('LOW 7: exactly ONE row announces, and it is not the raw server blob', async () => {
    // `Notice announce` delegates to the single GlobalLiveRegion, whose assertive
    // slot holds one string — three errored rows fired three messages and stomped
    // each other, each carrying a raw composed server error.
    mList.mockResolvedValue([
      source({ id: 'a', lastError: 'RAW-BLOB-A' }),
      source({ id: 'b', lastError: 'RAW-BLOB-B' }),
    ] as never);
    const { container } = render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('RAW-BLOB-A')).toBeTruthy());
    // `GlobalLiveRegion` lives at the app shell, not in this panel, so assert the
    // DELEGATION shape — `Notice` drops its own `role` exactly when it announces.
    // Two errored rows, ONE delegating.
    const notices = [...container.querySelectorAll('.alert.warning')];
    expect(notices).toHaveLength(2);
    expect(notices.filter((n) => !n.getAttribute('role'))).toHaveLength(1);
    // and both raw blobs are still READABLE — the fix moved them out of the
    // announcement, not out of the page.
    expect(screen.getByText('RAW-BLOB-B')).toBeTruthy();
  });
});
