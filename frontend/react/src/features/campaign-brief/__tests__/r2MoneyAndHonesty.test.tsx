/**
 * UX_UPGRADE-campaign-brief ROUND 2 — money truth, merge-preserving saves, and
 * failure honesty.
 *
 *  - CB-SP-3: the budget editor derives its exponent from the CURRENCY — a JPY
 *    total of 500000 minor units IS ¥500,000 and renders as "500000", not the
 *    /100 "5000".
 *  - CB-SP-4: a save with an empty total must NOT wipe the invisible
 *    perChannel allocations (agent-written data died on human save).
 *  - CB-SP-5: when the dirty save fails, Save&Validate must NOT go on to
 *    validate the stale stored brief.
 *  - CB-SP-6: failed org reads must not render "No organization yet".
 *  - CB-SP-2: a personas load failure resolves the loading sentinel (the R1
 *    briefs fix, finally applied to the second tab).
 *  - CB-SP-1: the delete confirm discloses the finalized-campaign orphan ONLY
 *    when one exists; a probe failure degrades to the base body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CampaignBrief } from '../campaignBriefClient.js';
import { currencyExponent, minorToMajorString, majorToMinor } from '../budgetUnits.js';

const listBriefs = vi.fn();
const updateBrief = vi.fn();
const validateBriefById = vi.fn();
const listPersonas = vi.fn();
const listOrgs = vi.fn();
const findCampaignForBrief = vi.fn();

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
  };
});
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CampaignBriefPage } from '../CampaignBriefPage.js';

const BRIEF: CampaignBrief = {
  id: 'brief-1', tenantId: 't', orgId: 'org-1', name: 'Spring launch', objective: 'Grow trials',
  personaIds: [], productName: 'Widget', productDescription: '', industryVertical: '',
  channels: [{ type: 'email_sequence', enabled: false }] as CampaignBrief['channels'],
  messaging: { primaryValueProp: '', proofPoints: [], ctaStrategy: '' } as CampaignBrief['messaging'],
  status: 'draft', kernelStale: false, createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

async function openDetail(): Promise<void> {
  render(<MemoryRouter><CampaignBriefPage /></MemoryRouter>);
  await act(async () => {});
  fireEvent.click(await screen.findByRole('button', { name: /spring launch/i }));
  await screen.findByRole('button', { name: /^Save$/ });
}

beforeEach(() => {
  listBriefs.mockReset().mockResolvedValue([BRIEF]);
  updateBrief.mockReset().mockResolvedValue(BRIEF);
  validateBriefById.mockReset().mockResolvedValue({ valid: true, issues: [], enabledChannels: [] });
  listPersonas.mockReset().mockResolvedValue([]);
  listOrgs.mockReset().mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  findCampaignForBrief.mockReset().mockResolvedValue(null);
});
afterEach(cleanup);

describe('CB-SP-3 — the budget exponent belongs to the currency', () => {
  it('unit: JPY has 0 decimals, USD 2, KWD 3; unknown/absent default to 2', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent(undefined)).toBe(2);
    expect(currencyExponent('NOPE')).toBe(2);
    expect(minorToMajorString(500000, 'JPY')).toBe('500000');
    expect(minorToMajorString(500000, 'USD')).toBe('5000');
    expect(majorToMinor('5000', 'JPY')).toBe(5000);
    expect(majorToMinor('5000', 'USD')).toBe(500000);
  });

  it('a stored JPY budget renders whole in the editor — not /100', async () => {
    listBriefs.mockResolvedValue([{ ...BRIEF, budget: { totalMinor: 500000, currency: 'JPY' } }]);
    await openDetail();
    const field = screen.getByLabelText(/Total budget/i) as HTMLInputElement;
    expect(field.value).toBe('500000');
  });
});

describe('CB-SP-4 — a save never wipes what the editor does not show', () => {
  it('an empty total preserves the invisible perChannel allocations', async () => {
    listBriefs.mockResolvedValue([{ ...BRIEF, budget: { perChannel: { ad_variants: 1000 } } }]);
    await openDetail();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await act(async () => {});
    const patch = updateBrief.mock.calls[0]![1] as { budget: unknown };
    // The old code sent budget:null here — destroying the allocations.
    expect(patch.budget).toEqual({ perChannel: { ad_variants: 1000 } });
  });
});

describe('CB-SP-5 — a failed save aborts Save&Validate', () => {
  it('does not validate the stale stored brief', async () => {
    updateBrief.mockRejectedValue(new Error('save exploded'));
    await openDetail();
    fireEvent.change(screen.getByLabelText(/Objective/i), { target: { value: 'Changed objective' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & validate/i }));
    await act(async () => {});
    expect(updateBrief).toHaveBeenCalled();
    // The old code swallowed the failure and validated anyway — reporting on a
    // document that is not the one on screen.
    expect(validateBriefById).not.toHaveBeenCalled();
    expect(await screen.findByText('save exploded')).toBeTruthy();
  });
});

describe('CB-SP-6 — failed reads are not empty states', () => {
  it('a failed orgs read never claims "No organization yet"', async () => {
    listOrgs.mockRejectedValue(new Error('boom'));
    listBriefs.mockResolvedValue([]);
    render(<MemoryRouter><CampaignBriefPage /></MemoryRouter>);
    await act(async () => {});
    expect(await screen.findByText(/Couldn't load your organizations/)).toBeTruthy();
    expect(screen.queryByText(/No organization yet/)).toBeNull();
  });
});

describe('CB-SP-2 — the personas tab resolves its loading sentinel on failure', () => {
  it('renders the load-failed card, not an eternal skeleton', async () => {
    listPersonas.mockRejectedValue(new Error('personas exploded'));
    render(<MemoryRouter initialEntries={['/?tab=personas']}><CampaignBriefPage /></MemoryRouter>);
    await act(async () => {});
    expect(await screen.findByText('personas exploded')).toBeTruthy();
    expect(screen.queryByText(/Loading personas/)).toBeNull();
  });
});

describe('CB-SP-1 — the delete confirm discloses the finalized-campaign orphan', () => {
  async function openDeleteDialog(): Promise<HTMLElement> {
    render(<MemoryRouter><CampaignBriefPage /></MemoryRouter>);
    await act(async () => {});
    await screen.findByRole('button', { name: /spring launch/i });
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {});
    return dialog;
  }

  it('discloses when a finalized campaign exists', async () => {
    findCampaignForBrief.mockResolvedValue({ id: 'camp-1', name: 'Big Campaign' });
    const dialog = await openDeleteDialog();
    expect(within(dialog).getByText(/Big Campaign/)).toBeTruthy();
    expect((dialog.textContent ?? '')).toMatch(/never be re-finalized/);
    // The base body stays — this adds, not replaces.
    expect((dialog.textContent ?? '')).toMatch(/cannot be undone/i);
  });

  it('polarity: no linked campaign → the base body only', async () => {
    findCampaignForBrief.mockResolvedValue(null);
    const dialog = await openDeleteDialog();
    expect((dialog.textContent ?? '')).not.toMatch(/re-finalized/);
  });

  it('a probe failure degrades to the base body — never a false claim either way', async () => {
    findCampaignForBrief.mockRejectedValue(new Error('probe boom'));
    const dialog = await openDeleteDialog();
    expect((dialog.textContent ?? '')).toMatch(/cannot be undone/i);
    expect((dialog.textContent ?? '')).not.toMatch(/re-finalized/);
  });
});

describe('R3 CB-G3 — the un-renameable brief gets an inline rename', () => {
  it('renames via a name-only patch (never the big save shape) and refuses a blank', async () => {
    await openDetail();
    fireEvent.click(screen.getByRole('button', { name: /rename brief/i }));
    const input = screen.getByRole('textbox', { name: /rename brief/i }) as HTMLInputElement;
    expect(input.value).toBe('Spring launch'); // pre-filled, not blank
    fireEvent.change(input, { target: { value: 'Autumn launch' } });
    const form = input.closest('form')!;
    fireEvent.click(within(form as HTMLElement).getByRole('button', { name: /^Save$/i }));
    await act(async () => {});
    expect(updateBrief).toHaveBeenCalledWith('brief-1', { name: 'Autumn launch' }); // name ONLY
    // Blank refuses locally: the rename form's save disables.
    fireEvent.click(screen.getByRole('button', { name: /rename brief/i }));
    const again = screen.getByRole('textbox', { name: /rename brief/i }) as HTMLInputElement;
    fireEvent.change(again, { target: { value: '   ' } });
    const renameSave = within(again.closest('form') as HTMLElement).getByRole('button', { name: /^Save$/i });
    expect((renameSave as HTMLButtonElement).disabled).toBe(true);
  });

  it('Escape cancels without a write', async () => {
    await openDetail();
    fireEvent.click(screen.getByRole('button', { name: /rename brief/i }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: /rename brief/i }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: /rename brief/i })).toBeNull();
    expect(updateBrief).not.toHaveBeenCalled();
  });
});
