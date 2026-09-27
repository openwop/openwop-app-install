/**
 * UX_UPGRADE-campaign-brief — CB-G1 / CB-G2.
 *
 *  - CB-G1: the validator returns `{ field, message }` per issue. The page threw
 *    `field` away and joined every message into one run-on line, so on a
 *    five-section editor the reader had to hunt for what the server had already
 *    pinpointed. Issues are now a list, each naming its section and taking the
 *    reader there.
 *  - CB-G2: Validate asks the server about the SAVED brief. With unsaved edits on
 *    screen that is a different document — the Review panel reads live form state
 *    while Validate answered about the stored one, so two panels on one screen
 *    could disagree. When the form is dirty the action saves first and says so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CampaignBrief, ValidationResult } from '../campaignBriefClient.js';

const listBriefs = vi.fn();
const validateBriefById = vi.fn();
const updateBrief = vi.fn();

vi.mock('../campaignBriefClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listBriefs: (...a: unknown[]) => listBriefs(...a),
    validateBriefById: (...a: unknown[]) => validateBriefById(...a),
    updateBrief: (...a: unknown[]) => updateBrief(...a),
    listPersonas: vi.fn(async () => []),
    listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
    listBrands: vi.fn(async () => []),
  };
});
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CampaignBriefPage } from '../CampaignBriefPage.js';

const BRIEF: CampaignBrief = {
  id: 'brief-1', tenantId: 't', orgId: 'org-1', name: 'Spring launch', objective: 'Grow trials',
  personaIds: [], productName: 'Widget', productDescription: '', industryVertical: '',
  // R2 CB-SP-13 — the fixture used 'email' (not a real channel enum; the real
  // one is 'email_sequence'), forced past the compiler with the cast, which
  // would mask an enum-keyed regression.
  channels: [{ type: 'email_sequence', enabled: false }] as CampaignBrief['channels'],
  messaging: { primaryValueProp: '', proofPoints: [], ctaStrategy: '' } as CampaignBrief['messaging'],
  status: 'draft', kernelStale: false, createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

const INVALID: ValidationResult = {
  valid: false,
  issues: [
    { field: 'personaIds', message: 'At least one persona is required.' },
    { field: 'messaging.primaryValueProp', message: 'A primary value proposition is required.' },
    { field: 'channels', message: 'Enable at least one channel.' },
  ],
  enabledChannels: [],
};

/** Open the brief detail and press the validate action. */
async function openAndValidate(): Promise<HTMLElement> {
  render(<MemoryRouter><CampaignBriefPage /></MemoryRouter>);
  await act(async () => {});
  fireEvent.click(await screen.findByRole('button', { name: /spring launch/i }));
  await screen.findByRole('button', { name: /validate/i });
  fireEvent.click(screen.getByRole('button', { name: /validate/i }));
  return await screen.findByRole('group', { name: /validation result/i });
}

beforeEach(() => {
  listBriefs.mockReset(); validateBriefById.mockReset(); updateBrief.mockReset();
  listBriefs.mockResolvedValue([BRIEF]);
  validateBriefById.mockResolvedValue(INVALID);
  updateBrief.mockResolvedValue(BRIEF);
});
afterEach(cleanup);

describe('brief validation summary', () => {
  it('CB-G1: lists each issue separately instead of one run-on line', async () => {
    const summary = await openAndValidate();
    expect(within(summary).getAllByRole('listitem')).toHaveLength(3);
  });

  it('CB-G1: each issue names the SECTION the server pointed at', async () => {
    const summary = await openAndValidate();
    // The `field` the validator returned is no longer discarded.
    expect(within(summary).getByRole('button', { name: 'Audience' })).toBeTruthy();
    expect(within(summary).getByRole('button', { name: 'Messaging' })).toBeTruthy();
    expect(within(summary).getByRole('button', { name: 'Channels' })).toBeTruthy();
  });

  it('CB-G1: clicking an issue focuses the section that owns it', async () => {
    const summary = await openAndValidate();
    fireEvent.click(within(summary).getByRole('button', { name: 'Messaging' }));
    // The section is focusable precisely so an issue can carry the reader to it.
    const focused = document.activeElement as HTMLElement;
    expect(focused.tagName).toBe('SECTION');
    expect(within(focused).getByText(/messaging/i)).toBeTruthy();
  });

  it('CB-G1: an UNRECOGNISED field still shows its message, with no jump offered', async () => {
    validateBriefById.mockResolvedValue({
      valid: false,
      issues: [{ field: 'somethingNew', message: 'A new rule fired.' }],
      enabledChannels: [],
    } satisfies ValidationResult);
    const summary = await openAndValidate();
    expect(within(summary).getByText(/A new rule fired\./)).toBeTruthy();
    // We do not guess where an unknown field lives.
    expect(within(summary).queryByRole('button', { name: 'somethingNew' })).toBeNull();
  });

  it('CB-G1: a valid brief still reports success, not an empty list', async () => {
    validateBriefById.mockResolvedValue({ valid: true, issues: [], enabledChannels: ['email_sequence'] } satisfies ValidationResult);
    const summary = await openAndValidate();
    expect(within(summary).queryAllByRole('listitem')).toHaveLength(0);
    expect(summary.textContent ?? '').not.toBe('');
  });
});

describe('validate reports on the document you are looking at', () => {
  it('CB-G2: a clean form validates WITHOUT saving', async () => {
    await openAndValidate();
    await waitFor(() => expect(validateBriefById).toHaveBeenCalled());
    expect(updateBrief).not.toHaveBeenCalled();
  });

  it('CB-G2: an edited form saves FIRST, so the answer is about what is on screen', async () => {
    render(<MemoryRouter><CampaignBriefPage /></MemoryRouter>);
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: /spring launch/i }));
    await screen.findByRole('button', { name: /^validate$/i });

    // Edit the value prop the validator complains about.
    const valueProp = screen.getByLabelText(/value prop/i);
    fireEvent.change(valueProp, { target: { value: 'The fastest widget' } });

    // The action renames itself, so the save is disclosed rather than surprising.
    const action = await screen.findByRole('button', { name: /save & validate/i });
    fireEvent.click(action);

    await waitFor(() => expect(updateBrief).toHaveBeenCalled());
    // The edit reached the server before the question was asked.
    const [, payload] = updateBrief.mock.calls[0] as [string, { messaging: { primaryValueProp: string } }];
    expect(payload.messaging.primaryValueProp).toBe('The fastest widget');
    await waitFor(() => expect(validateBriefById).toHaveBeenCalled());
  });
});
