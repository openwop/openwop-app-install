/**
 * UX_UPGRADE-podcasts ROUND 2 — ShowsManager's FIRST tests (XP-R2-1).
 *
 * SP-2 pinned: the validity warning has always instructed "add artwork /
 * category / owner email…" while NO edit surface existed — `updateShow` was
 * imported by nothing. These tests pin the edit form as that instruction's
 * performable counterpart:
 *  - the form opens PRE-FILLED from the show (not blank — blank would invite
 *    accidental erasure of good fields);
 *  - save calls `updateShow` with the newly added fields;
 *  - artwork rides the shared MediaPickerDialog and lands as `imageMediaRef`.
 * Subject: `ShowsManager` (ADR 0390 shows & distribution; SP-9 canWrite gating).
 *
 * Sabotage-witnessed (grade-tests w21): blank pre-fill, dropping ownerEmail from
 * the patch, storing the bare token instead of `serveUrl`, skipping the re-read,
 * hiding the validity Notice, and closing the form / dropping the toast on a failed
 * save each red the case that claims them; forcing `canWrite` either way reds the
 * SP-9 pair; `canWrite === true` in the client reds the older-wire case.
 * (w21 found the validity assertion here VACUOUS — `/required/` matched the create
 * form's "Owner email (required by Apple)" label — and it now asserts the copy.)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor, within } from '@testing-library/react';

const { listShowsWithCapability, updateShow, createShow } = vi.hoisted(() => ({
  listShowsWithCapability: vi.fn(), updateShow: vi.fn(), createShow: vi.fn(),
}));
vi.mock('../podcastsClient.js', async (orig) => ({
  ...(await orig<typeof import('../podcastsClient.js')>()),
  listShowsWithCapability, updateShow, createShow,
}));
vi.mock('../../media/MediaPickerDialog.js', () => ({
  // Review F2 — the mock hands back the REAL MediaAsset shape (serveUrl is the
  // root-relative path); asserting a bare token here previously PINNED the bug.
  MediaPickerDialog: ({ onSelect }: { onSelect: (a: { serveUrl: string; serveToken?: string }) => void }) => (
    <button type="button" data-testid="pick-asset" onClick={() => onSelect({ serveUrl: '/host/openwop-app/assets/tok-art-1', serveToken: 'tok-art-1' })}>pick</button>
  ),
}));
const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: toastError } }));

import { ShowsManager } from '../ShowsManager.js';
import type { PodcastShow } from '../podcastsClient.js';

const SHOW: PodcastShow = {
  id: 'sh1', orgId: 'o1', slug: 'acme-hour', title: 'The Acme Hour', author: 'Acme',
  description: 'Weekly talk', languageCode: 'en', explicit: false,
  type: 'episodic', published: false, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listShowsWithCapability.mockResolvedValue({ shows: [SHOW], canWrite: true });
});

const mount = async (): Promise<void> => {
  render(<ShowsManager orgId="o1" />);
  await act(async () => {});
};

describe('R2 SP-2 — the show edit form makes the validity instruction performable', () => {
  it('opens PRE-FILLED and saves the ADDED fields (owner email + artwork) through updateShow', async () => {
    updateShow.mockResolvedValue({ ...SHOW, ownerEmail: 'pod@acme.test' });
    await mount();
    await screen.findByText('The Acme Hour');
    // The warning names what's missing — the instruction this form serves.
    // SHOW has author + description but no owner email / artwork / category —
    // exactly those three, named in the validity copy (not a field label).
    expect(screen.getByText(/before submitting to a directory, add: owner email, channel artwork, category\./i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    // Scope to the EDIT form (the create form below shares field labels).
    const editForm = screen.getByText(/edit “the acme hour”/i).closest('form')! as HTMLFormElement;
    expect((within(editForm).getByLabelText(/title/i) as HTMLInputElement).value).toBe('The Acme Hour'); // pre-filled, never blank

    fireEvent.change(within(editForm).getByLabelText(/owner email/i), { target: { value: 'pod@acme.test' } });
    fireEvent.click(within(editForm).getByRole('button', { name: /choose artwork/i })); // opens the shared picker
    fireEvent.click(within(editForm).getByTestId('pick-asset'));
    fireEvent.click(within(editForm).getByRole('button', { name: /save show/i }));

    await waitFor(() => expect(updateShow).toHaveBeenCalledWith('sh1', expect.objectContaining({
      title: 'The Acme Hour',
      author: 'Acme',
      ownerEmail: 'pod@acme.test',
      imageMediaRef: '/host/openwop-app/assets/tok-art-1',
    })));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    // Saved → the list re-reads.
    expect(listShowsWithCapability).toHaveBeenCalledTimes(2);
  });

  it('a failed save reports the failure and keeps the form open (no silent loss)', async () => {
    updateShow.mockRejectedValue(new Error('http 500'));
    await mount();
    await screen.findByText('The Acme Hour');
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    const editForm = screen.getByText(/edit “the acme hour”/i).closest('form')! as HTMLFormElement;
    fireEvent.change(within(editForm).getByLabelText(/owner email/i), { target: { value: 'kept@acme.test' } });
    fireEvent.click(within(editForm).getByRole('button', { name: /save show/i }));
    // The failure is reported with the server's message, not swallowed.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('http 500'));
    expect(toastSuccess).not.toHaveBeenCalled();
    // The form is still on screen AND still holds the operator's edit.
    const stillOpen = screen.getByText(/edit “the acme hour”/i).closest('form')! as HTMLFormElement;
    expect((within(stillOpen).getByLabelText(/owner email/i) as HTMLInputElement).value).toBe('kept@acme.test');
  });
});

describe('SP-9 (round 3) — write actions render only when the server reports canWrite', () => {
  it('canWrite:false — Edit/Publish/Delete and the create form are GONE', async () => {
    listShowsWithCapability.mockResolvedValue({ shows: [SHOW], canWrite: false });
    await mount();
    await screen.findByText('The Acme Hour');
    // The show still renders (the read is not narrowed) …
    // … but every write affordance is gone, replaced by one honest disclosure.
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /publish/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /create show/i })).toBeNull();
    // The disclosure renders ONCE at the studio level (ShowsManager's only
    // consumer) — asserted in orgsFailedNotEmpty.test.tsx, not duplicated here.
  });

  it('canWrite:true (the paired polarity) — the same queries FIND the actions', async () => {
    await mount(); // beforeEach: canWrite true
    await screen.findByText('The Acme Hour');
    expect(screen.getByRole('button', { name: /edit/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^publish$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /delete/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /create show/i })).toBeTruthy();
  });
});

describe('SP-9 — older-wire default (client maps absent canWrite to TRUE, false stays false)', () => {
  it('listShowsWithCapability: canWrite omitted → true; explicit false → false', async () => {
    const real = await vi.importActual<typeof import('../podcastsClient.js')>('../podcastsClient.js');
    const mkRes = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      // An older server omits canWrite entirely → default TRUE (hiding working
      // actions would be the worse failure; the 403 stays the authority).
      fetchSpy.mockResolvedValueOnce(mkRes({ shows: [] }));
      expect((await real.listShowsWithCapability('o1')).canWrite).toBe(true);
      // The new wire's explicit false is preserved.
      fetchSpy.mockResolvedValueOnce(mkRes({ shows: [], canWrite: false }));
      expect((await real.listShowsWithCapability('o1')).canWrite).toBe(false);
    } finally { fetchSpy.mockRestore(); }
  });
});
