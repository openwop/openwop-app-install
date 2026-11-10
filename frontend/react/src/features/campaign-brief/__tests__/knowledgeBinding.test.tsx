/**
 * CORE-4 (ADR 0351 P2 grounding policy) — strict generation needs a source
 * collection picked through the brief UI. Collections come only from the brief's
 * client; nothing is chosen automatically; Save & validate validates the SAVED
 * binding (R2 CB-SP-5: save first, then validate); a stored binding that is now
 * unavailable is preserved on unrelated saves and removed only explicitly; a
 * FAILED collections read is not presented as an empty client (failure honesty) and
 * never clears the saved binding.
 *
 * Red when (sabotage-witnessed, w93): collections are read for another org; the
 * brief payload drops an empty `kbCollectionId`; validate runs before the save
 * lands; the unavailable option or its notice disappears; Clear does nothing; a
 * failed read reads as empty, leaves the picker enabled, or Retry does nothing;
 * the manage link loses the collection; an empty client loses its notice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CampaignBrief } from '../campaignBriefClient.js';
import type { KbCollection } from '../../kb/kbClient.js';

const listCollections = vi.fn();
vi.mock('../../kb/kbClient.js', () => ({ listCollections: (...a: unknown[]) => listCollections(...a) }));
const listBriefs = vi.fn();
const updateBrief = vi.fn();
const validateBriefById = vi.fn();
const listPersonas = vi.fn();
const listOrgs = vi.fn();
const findCampaignForBrief = vi.fn();
const getPendingKernelRun = vi.fn();

vi.mock('../campaignBriefClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listBriefs: (..._a: unknown[]) => listBriefs(),
    updateBrief: (...a: unknown[]) => updateBrief(...a),
    validateBriefById: (...a: unknown[]) => validateBriefById(...a),
    listPersonas: (..._a: unknown[]) => listPersonas(),
    listOrgs: (..._a: unknown[]) => listOrgs(),
    listBrands: vi.fn(async () => []),
    deleteBrief: vi.fn(async () => {}),
    findCampaignForBrief: (...a: unknown[]) => findCampaignForBrief(...a),
    getPendingKernelRun: (...a: unknown[]) => getPendingKernelRun(...a),
  };
});
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CampaignBriefPage } from '../CampaignBriefPage.js';

const BRIEF: CampaignBrief = {
  id: 'brief-1', tenantId: 't', orgId: 'org-1', name: 'Spring launch', objective: 'Grow trials',
  personaIds: [], productName: 'Widget', productDescription: '', industryVertical: '',
  channels: [{ type: 'email_sequence', enabled: false, config: {} }],
  messaging: { primaryValueProp: '', toneOverride: '', proofPoints: [], ctaStrategy: '' },
  status: 'draft', kernelStale: false, createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

async function openDetail(): Promise<void> {
  render(<MemoryRouter><CampaignBriefPage /></MemoryRouter>);
  await act(async () => {});
  fireEvent.click(await screen.findByRole('button', { name: /spring launch/i }));
  await screen.findByRole('button', { name: /^Save$/ });
}

beforeEach(() => {
  listCollections.mockReset().mockResolvedValue([{ collectionId: 'kb-own', name: 'Client source documents', documentCount: 1, chunkCount: 2, updatedAt: '2026-11-05T00:00:00.000Z' }] satisfies KbCollection[]);
  listBriefs.mockReset().mockResolvedValue([BRIEF]);
  updateBrief.mockReset().mockResolvedValue(BRIEF);
  validateBriefById.mockReset().mockResolvedValue({ valid: true, issues: [], enabledChannels: [] });
  listPersonas.mockReset().mockResolvedValue([]);
  listOrgs.mockReset().mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  findCampaignForBrief.mockReset().mockResolvedValue(null);
  getPendingKernelRun.mockReset().mockResolvedValue(null);
});
afterEach(cleanup);


describe('brief knowledge collection binding', () => {
  it('offers only the current client endpoint, saves the selected binding and reads it after reload', async () => {
    let saved = { ...BRIEF };
    listBriefs.mockImplementation(async () => [saved]);
    updateBrief.mockImplementation(async (_id: string, patch: Partial<CampaignBrief>) => { saved = { ...saved, ...patch }; return saved; });
    await openDetail();
    const field = await screen.findByRole('combobox', { name: 'Knowledge collection' });
    await screen.findByRole('option', { name: 'Client source documents' });
    expect(listCollections).toHaveBeenCalledWith('org-1');
    expect(listCollections.mock.calls.every(([org]) => org === 'org-1')).toBe(true);
    expect(field).toHaveValue(''); // never choose the first collection automatically
    fireEvent.change(field, { target: { value: 'kb-own' } });
    // Record what was stored when validate ran, and assert it OUTSIDE the mock:
    // validate() catches errors, so an expect inside the mock could never fail.
    let kbAtValidate: string | undefined = 'validate-not-called';
    validateBriefById.mockImplementation(async () => {
      kbAtValidate = saved.kbCollectionId;
      return { valid: true, issues: [], enabledChannels: [] };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save & validate' }));
    await act(async () => {});
    expect(updateBrief).toHaveBeenCalledWith('brief-1', expect.objectContaining({ kbCollectionId: 'kb-own' }));
    expect(validateBriefById).toHaveBeenCalledWith('brief-1');
    expect(kbAtValidate).toBe('kb-own'); // validated the saved binding, never the previous row
    cleanup();
    await openDetail();
    expect(await screen.findByRole('combobox', { name: 'Knowledge collection' })).toHaveValue('kb-own');
    fireEvent.change(screen.getByRole('combobox', { name: 'Knowledge collection' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await act(async () => {});
    expect(updateBrief).toHaveBeenLastCalledWith('brief-1', expect.objectContaining({ kbCollectionId: '' }));
  });

  it('preserves an unavailable stored binding on unrelated saves and allows explicit removal', async () => {
    listBriefs.mockResolvedValue([{ ...BRIEF, kbCollectionId: 'kb-deleted' }]);
    await openDetail();
    await screen.findByText('The saved collection is unavailable. Choose another collection or clear this binding.');
    expect(screen.getByRole('combobox', { name: 'Knowledge collection' })).toHaveValue('kb-deleted');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await act(async () => {});
    expect(updateBrief).toHaveBeenLastCalledWith('brief-1', expect.objectContaining({ kbCollectionId: 'kb-deleted' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear knowledge collection' }));
    expect(screen.getByRole('combobox', { name: 'Knowledge collection' })).toHaveValue('');
  });

  it('distinguishes a failed collection read from an empty client and retries without losing the saved binding', async () => {
    listCollections.mockRejectedValueOnce(new Error('unavailable'));
    listBriefs.mockResolvedValue([{ ...BRIEF, kbCollectionId: 'kb-own' }]);
    await openDetail();
    await screen.findByText('Knowledge collections could not be loaded. Your saved binding is unchanged.');
    expect(screen.queryByText('No knowledge collections are available for this client.')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Knowledge collection' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry knowledge collections' }));
    await screen.findByRole('option', { name: 'Client source documents' });
    expect(screen.getByRole('combobox', { name: 'Knowledge collection' })).toHaveValue('kb-own');
    expect(screen.getByRole('link', { name: 'Manage source documents' })).toHaveAttribute('href', '/kb?org=org-1&collection=kb-own');
  });

  it('offers source setup for a genuinely empty client with no invented default', async () => {
    listCollections.mockResolvedValue([] satisfies KbCollection[]);
    await openDetail();
    await screen.findByText('No knowledge collections are available for this client.');
    expect(screen.getByRole('combobox', { name: 'Knowledge collection' })).toHaveValue('');
    expect(screen.getByRole('link', { name: 'Manage source documents' })).toHaveAttribute('href', '/kb?org=org-1');
  });
});
