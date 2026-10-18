/**
 * Brand editor — merge-preserving save, 409 copy, delete failure, audit reader
 * (UX_UPGRADE-brand round 2/3: XBR-0/1/3, BR-SP-1/2/5/7). The filename is the
 * grading-pass name; it stays because ADR 0661 cites it.
 *
 *  - BR-SP-1 (Blocker): the save payload spreads the LOADED brand's facets —
 *    a rename must carry governance.allowedEditors/compliance and voice
 *    samplePhrases through, not wipe them (a wiped allowedEditors silently
 *    revokes a partial lock's editors).
 *  - BR-SP-2: a failed delete shows its error IN the dialog (which stays
 *    open); the confirm is busy-guarded while the delete is in flight.
 *  - BR-SP-5: the update carries expectedUpdatedAt; a conflict shows the
 *    localized conflict copy, never the raw server sentence.
 *  - BR-SP-7: the audit trail is read lazily, and failed ≠ empty.
 *
 * Sabotage-witnessed (w52): dropping the governance / voiceProfile spreads or the
 * expectedUpdatedAt token; `status === 409` → `410`; the delete error routed to
 * the page Notice, or the dialog closed in `finally`; `busy={false}`; the audit
 * arrow reversed; an audit failure becoming `[]`; an eager audit load.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import type { Brand } from '../brandClient.js';
import type * as C from '../brandClient.js';

const listBrands = vi.fn<typeof C.listBrands>();
const listOrgs = vi.fn<typeof C.listOrgs>();
const updateBrand = vi.fn<typeof C.updateBrand>();
const createBrand = vi.fn<typeof C.createBrand>();
const deleteBrand = vi.fn<typeof C.deleteBrand>();
const getBrandAudit = vi.fn<typeof C.getBrandAudit>();
const listBrandFonts = vi.fn<typeof C.listBrandFonts>();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
// ADR 0891 BR2UX-1 — a partial lock now lists the org's members to pick editors from.
vi.mock('../../../orgs/orgMembers.js', () => ({ loadOrgMembers: vi.fn(async () => []) }));
vi.mock('../brandClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listBrands: () => listBrands(),
  listOrgs: () => listOrgs(),
  updateBrand: (...a: Parameters<typeof C.updateBrand>) => updateBrand(...a),
  createBrand: (...a: Parameters<typeof C.createBrand>) => createBrand(...a),
  deleteBrand: (...a: Parameters<typeof C.deleteBrand>) => deleteBrand(...a),
  getBrandAudit: (...a: Parameters<typeof C.getBrandAudit>) => getBrandAudit(...a),
  // ADR 0661 — this factory spreads `importOriginal()`, so any export it does not
  // name keeps its REAL implementation. `listBrandFonts` was unnamed, so the fonts
  // panel issued a live `fetch` out of jsdom and rendered its failed state in a
  // test that never asked for one. Nothing here asserts on fonts; an empty list is
  // the honest stand-in.
  listBrandFonts: (...a: Parameters<typeof C.listBrandFonts>) => listBrandFonts(...a),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { BrandPage } = await import('../BrandPage.js');

const brand = (over: Partial<Brand> = {}): Brand => ({
  id: 'b1', tenantId: 't1', orgId: 'org:1', name: 'Solstice', description: '', status: 'active',
  voiceProfile: { voice: 'warm', formalityLevel: 2, guidelines: '', samplePhrases: ['hello there'], avoidPhrases: [], toneRegisters: [] },
  positioning: { tagline: 'Shine', elevatorPitch: '', differentiators: ['fast'], competitiveFrame: '' },
  keyPhrases: { approvedTaglines: [], bannedPhrases: [], valuePropositions: ['value!'], productDescriptors: [] },
  channelVoiceRules: [],
  governance: { lockLevel: 'partial', allowedEditors: ['user:listed'], requireApproval: true, compliance: { blockPublish: 'critical' } },
  createdBy: 'u1', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-08T00:00:00Z',
  ...over,
});

const renderPage = () => render(<BrandPage />);

beforeEach(() => {
  // mockReset, not clearAllMocks: a case's rejected update/delete or queued audit
  // answer must never reach the next case (shuffle-safe).
  for (const m of [listBrands, listOrgs, updateBrand, createBrand, deleteBrand, getBrandAudit, listBrandFonts]) m.mockReset();
  listBrands.mockResolvedValue([brand()]);
  listOrgs.mockResolvedValue([{ orgId: 'org:1', name: 'Acme' }]);
  listBrandFonts.mockResolvedValue([]);
});
afterEach(cleanup);

describe('BR-SP-1 — the merge-preserving save', () => {
  it('a rename-only save carries governance + agent-authored fields THROUGH', async () => {
    updateBrand.mockResolvedValue(brand({ name: 'Solstice v2' }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Solstice/ }));
    const name = await screen.findByDisplayValue('Solstice');
    fireEvent.change(name, { target: { value: 'Solstice v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateBrand).toHaveBeenCalled());
    const payload = updateBrand.mock.calls[0]![1] as { governance: Record<string, unknown>; voiceProfile: Record<string, unknown>; keyPhrases: Record<string, unknown>; positioning: Record<string, unknown>; expectedUpdatedAt?: string };
    // The Blocker: these were wiped by the old fields-only payload.
    expect(payload.governance.allowedEditors).toEqual(['user:listed']);
    expect(payload.governance.requireApproval).toBe(true);
    expect(payload.governance.compliance).toEqual({ blockPublish: 'critical' });
    expect(payload.voiceProfile.samplePhrases).toEqual(['hello there']);
    expect(payload.keyPhrases.valuePropositions).toEqual(['value!']);
    expect(payload.positioning.differentiators).toEqual(['fast']);
    // BR-SP-5 — the CAS token rides along.
    expect(payload.expectedUpdatedAt).toBe('2026-08-08T00:00:00Z');
  });

  it('a save conflict shows the localized conflict copy', async () => {
    const conflict = Object.assign(new Error('This brand changed since you opened it — reload and reapply your edits.'), { status: 409 });
    updateBrand.mockRejectedValue(conflict);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Solstice/ }));
    await screen.findByDisplayValue('Solstice');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const dialog = screen.getByRole('dialog');
    // The localized copy, IN the dialog (the parent Notice holds a second copy)…
    expect(await within(dialog).findByText(/close the editor, reload, and reapply your edits/i)).toBeTruthy();
    // …and it REPLACES the raw server sentence rather than riding beside it.
    expect(screen.queryByText('This brand changed since you opened it — reload and reapply your edits.')).toBeNull();
  });
});

describe('BR-SP-2 — delete failure lives in the dialog', () => {
  it('the dialog stays open and shows the error; the list Notice is not the only surface', async () => {
    deleteBrand.mockRejectedValue(new Error('governance says no'));
    renderPage();
    // The row's icon-only delete opens the dialog; the dialog's affirmative
    // button shares the same accessible name, so scope the second click.
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(deleteBrand).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeTruthy(); // still open
    expect(await screen.findByText(/governance says no/)).toBeTruthy();
    expect(dialog.contains(screen.getByText(/governance says no/))).toBe(true); // IN the dialog
  });

  it('the confirm is busy while the delete is in flight — a second click cannot fire it again', async () => {
    deleteBrand.mockReturnValue(new Promise<void>(() => { /* held in flight for the whole case */ }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog');
    const confirmBtn = within(dialog).getByRole('button', { name: /^delete$/i });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(deleteBrand).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((confirmBtn as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(confirmBtn);
    expect(deleteBrand).toHaveBeenCalledTimes(1);
  });
});

describe('R3 BR-SP-7 — the audit trail gets its reader (lazy disclosure, failed ≠ empty)', () => {
  const openEditorAndAudit = async (): Promise<void> => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Solstice/ }));
    await screen.findByDisplayValue('Solstice');
    fireEvent.click(screen.getByRole('button', { name: /change history/i }));
    await act(async () => {});
  };

  it('renders field-level from→to rows, lazily on first open', async () => {
    getBrandAudit.mockResolvedValue([
      { auditId: 'a1', actor: 'user:me', changedAt: '2026-08-14T00:00:00Z', changes: [{ field: 'governance.lockLevel', from: 'partial', to: 'full' }] },
    ]);
    await openEditorAndAudit();
    expect(getBrandAudit).toHaveBeenCalledWith('b1');
    expect(await screen.findByText('governance.lockLevel')).toBeTruthy();
    expect(screen.getByText(/"partial" → "full"/)).toBeTruthy();
  });

  it('a FAILED read says failed-not-empty; the clean zero is the designed empty state', async () => {
    getBrandAudit.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([]);
    await openEditorAndAudit();
    expect(await screen.findByText(/could not be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/No guardrail changes/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/No guardrail changes/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });

  it('the editor never fetches the audit until the disclosure opens', async () => {
    getBrandAudit.mockResolvedValue([]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Solstice/ }));
    await screen.findByDisplayValue('Solstice');
    expect(getBrandAudit).not.toHaveBeenCalled();
  });
});
