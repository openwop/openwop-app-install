/**
 * UX_UPGRADE-brand — BR-G1 / BR-G2 / BR-G3.
 *
 *  - BR-G1: a save failure has to be visible INSIDE the dialog. It used to be
 *    reported to the parent page, which renders outside `ModalPortal` — i.e.
 *    behind the scrim — so a rejected save looked like a Save button that did
 *    nothing. The governance refusal ("only an org admin may edit it") is a
 *    genuinely useful sentence that no user had ever seen.
 *  - BR-G2: a locked brand states its rule up front rather than after five
 *    fieldsets of work.
 *  - BR-G3: the channel select cannot author a duplicate rule, because scoring
 *    resolves channels first-match-wins and the duplicate would be inert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import type { Brand } from '../brandClient.js';

const listBrands = vi.fn();
const updateBrand = vi.fn();

vi.mock('../brandClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listBrands: () => listBrands(),
    updateBrand: (id: string, input: unknown) => updateBrand(id, input),
    createBrand: vi.fn(async () => ({})),
    deleteBrand: vi.fn(async () => {}),
    listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
    listBrandFonts: vi.fn(async () => []),
  };
});

import { BrandPage } from '../BrandPage.js';

function brand(over: Partial<Brand> = {}): Brand {
  return {
    id: 'brand-1', orgId: 'org-1', name: 'Acme Brand', description: 'The house voice', status: 'active',
    voiceProfile: { voice: 'warm', formalityLevel: 3, guidelines: '' },
    keyPhrases: { approvedTaglines: [], bannedPhrases: [], valuePropositions: [], productDescriptors: [] },
    positioning: { tagline: '', elevatorPitch: '' },
    channelVoiceRules: [],
    governance: { lockLevel: 'none', allowedEditors: [], requireApproval: false },
    createdBy: 'user:someone-else', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Brand;
}

/** Open the editor for the first (only) brand in the list. */
async function openEditor(): Promise<void> {
  render(<BrandPage />);
  await act(async () => {});
  const row = await screen.findByRole('button', { name: /acme brand/i });
  fireEvent.click(row);
  await screen.findByRole('dialog');
}

beforeEach(() => {
  listBrands.mockReset();
  updateBrand.mockReset();
  listBrands.mockResolvedValue([brand()]);
  updateBrand.mockResolvedValue({});
});
afterEach(cleanup);

describe('brand editor — governance + failure visibility', () => {
  it('BR-G1: a rejected save shows its reason INSIDE the dialog', async () => {
    updateBrand.mockRejectedValue(new Error('This brand is locked — only an org admin may edit it.'));
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    const dialog = await screen.findByRole('dialog');
    // The server's sentence, where the user is actually looking — not in the
    // page behind the scrim.
    await waitFor(() =>
      expect(within(dialog).getByText(/only an org admin may edit it/i)).toBeTruthy());
  });

  it('BR-G1: the dialog stays open after a rejected save, so the work is not lost', async () => {
    updateBrand.mockRejectedValue(new Error('nope'));
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText('nope')).toBeTruthy());
    // Still open, with the form state intact — a rejected save must not discard
    // the work. (The parent page also holds the message so it survives a
    // dismissal, which is why this scopes the query to the dialog.)
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('BR-G2: a fully-locked brand states who can save BEFORE the form', async () => {
    listBrands.mockResolvedValue([brand({ governance: { lockLevel: 'full', allowedEditors: [], requireApproval: false } })]);
    await openEditor();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/only an org admin can save changes/i)).toBeTruthy();
  });

  it('BR-G2: a partially-locked brand states the narrower rule', async () => {
    listBrands.mockResolvedValue([brand({ governance: { lockLevel: 'partial', allowedEditors: ['user:a'], requireApproval: false } })]);
    await openEditor();
    expect(within(screen.getByRole('dialog')).getByText(/creator, a listed editor, or an org admin/i)).toBeTruthy();
  });

  it('BR-G2: an unlocked brand says nothing — the notice is a signal, not decoration', async () => {
    await openEditor();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText(/can save changes/i)).toBeNull();
  });

  it('BR-G3: the channel select never offers a channel another rule already uses', async () => {
    listBrands.mockResolvedValue([brand({
      channelVoiceRules: [
        { channel: 'email_sequence', tone: 'brisk', samplePhrases: [], avoidPhrases: [] },
        { channel: 'social_posts', tone: 'short', samplePhrases: [], avoidPhrases: [] },
      ],
    })]);
    await openEditor();
    const selects = screen.getAllByLabelText(/channel/i) as HTMLSelectElement[];
    const first = selects[0]!;
    const offered = Array.from(first.options).map((o) => o.value);
    // Its own channel stays selectable …
    expect(offered).toContain('email_sequence');
    // … but the one the OTHER rule holds is gone. Scoring is first-match-wins,
    // so a duplicate would be authored-but-inert.
    expect(offered).not.toContain('social_posts');
  });
});
