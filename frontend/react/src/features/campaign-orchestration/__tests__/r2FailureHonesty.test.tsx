/**
 * UX_UPGRADE-campaign-orchestration ROUND 2 — the failure-honesty and
 * money-truth set.
 *
 *  - CO-SP-1 (Blocker): a failed dispatch-ledger read must render as a FAILURE,
 *    never "No live ad dispatches yet" — the rows are real paused platform
 *    campaigns with budgets.
 *  - CO-SP-2: a failed briefs read must not render "No briefs found".
 *  - CO-SP-3: a failed status change must be VISIBLE from the detail view.
 *  - CO-SP-4: switching org in the finalize modal must reset the brief
 *    selection (the old `cur || …` kept org A's brief while org B rendered).
 *  - CO-SP-7: the campaign's planned budget renders WITH its ISO currency —
 *    JPY proves the decimals derive from the currency, not a bare `/100`.
 *  - CO-SP-12: kernel-less briefs are listed but not selectable.
 *
 * Selection claims (CO-SP-4/12) are asserted through the SUBMIT
 * (`finalizeBrief` argument), never `select.value`: a controlled <select> whose
 * state matches no option displays the first enabled option, so a stale org-A
 * briefId reads as org B's brief in the DOM (w31 probe rf-org-switch-reset was
 * vacuous against the DOM read). Sabotage: restoring the `cur || …` selection
 * without the reset reds CO-SP-4; preselecting `''` or `b[0]` reds CO-SP-12;
 * mapping a failed ledger read to `[]` reds CO-SP-1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../CampaignLedgerSection.js', () => ({ CampaignLedgerSection: () => null })); // own tests: campaignLedgerSection.test.tsx
import { render, screen, cleanup, fireEvent, act, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AdDispatch, BriefRef, MarketingCampaign, MessagingKernel, OrgRef } from '../campaignStudioClient.js';

const listCampaigns = vi.fn();
const listDispatches = vi.fn();
const listBriefs = vi.fn();
const listOrgs = vi.fn();
const updateCampaign = vi.fn();
const finalizeBrief = vi.fn();

vi.mock('../campaignStudioClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listCampaigns: (..._a: unknown[]) => listCampaigns(),
    listDispatches: (...a: unknown[]) => listDispatches(...a),
    listBriefs: (...a: unknown[]) => listBriefs(...a),
    listOrgs: (..._a: unknown[]) => listOrgs(),
    deleteCampaign: vi.fn(async () => {}),
    updateCampaign: (...a: unknown[]) => updateCampaign(...a),
    finalizeBrief: (...a: unknown[]) => finalizeBrief(...a),
  };
});
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CampaignStudioPage } from '../CampaignStudioPage.js';

const CAMPAIGN: MarketingCampaign = {
  id: 'camp-1', tenantId: 't1', orgId: 'org-a', briefId: 'brief-a1', name: 'Spring push', status: 'active',
  channels: ['ad_variants'], objective: 'Grow trials', personaIds: [], createdBy: 'u1',
  createdAt: '2026-07-01T08:00:00.000Z', updatedAt: '2026-07-02T08:00:00.000Z',
};

const KERNEL: MessagingKernel = {
  headline: 'h', supportingStatement: 's', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
  tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00.000Z',
};

const ORGS: OrgRef[] = [{ orgId: 'org-a', name: 'Acme' }, { orgId: 'org-b', name: 'Borealis' }];
// The kernel-less draft is FIRST, so a "preselect the first brief" regression
// would pick it and be caught by the submit assertion below.
const BRIEFS_A: BriefRef[] = [
  { id: 'brief-a2', name: 'Draft brief', status: 'draft' }, // no kernel — not selectable
  { id: 'brief-a1', name: 'Alpha brief', status: 'confirmed', kernel: KERNEL },
];
const BRIEFS_B: BriefRef[] = [
  { id: 'brief-b1', name: 'Boreal brief', status: 'confirmed', kernel: KERNEL },
];

async function openPage(): Promise<void> {
  render(<MemoryRouter><CampaignStudioPage /></MemoryRouter>);
  await act(async () => {});
}

async function openDetail(): Promise<void> {
  await openPage();
  fireEvent.click(await screen.findByRole('button', { name: /spring push/i }));
  await screen.findByText(/Launch state/i);
}

beforeEach(() => {
  listCampaigns.mockReset().mockResolvedValue([CAMPAIGN]);
  listDispatches.mockReset().mockResolvedValue([]);
  listBriefs.mockReset().mockResolvedValue(BRIEFS_A);
  listOrgs.mockReset().mockResolvedValue(ORGS);
  updateCampaign.mockReset().mockResolvedValue(CAMPAIGN);
  finalizeBrief.mockReset().mockResolvedValue({ id: 'camp-9', name: 'New' });
});
afterEach(cleanup);

describe('CO-SP-1 — a failed ledger read is a failure, not an empty ledger', () => {
  it('renders the failure copy and never the empty copy', async () => {
    listDispatches.mockRejectedValue(new Error('boom'));
    await openDetail();
    expect(await screen.findByText(/Couldn't load the dispatch ledger/)).toBeTruthy();
    expect(screen.queryByText(/No live ad dispatches yet/)).toBeNull();
  });

  it('polarity: a SUCCESSFUL empty read still renders the designed empty copy', async () => {
    listDispatches.mockResolvedValue([]);
    await openDetail();
    expect(await screen.findByText(/No live ad dispatches yet/)).toBeTruthy();
    expect(screen.queryByText(/Couldn't load the dispatch ledger/)).toBeNull();
  });

  it('a real row also states statuses are as-of dispatch time, with ad-set/ad ids', async () => {
    listDispatches.mockResolvedValue([{
      platform: 'meta', platformCampaignId: 'mc-9', platformAdSetId: 'as-9', platformAdId: 'ad-9',
      createdAt: '2026-07-02T09:30:00.000Z',
    } satisfies AdDispatch]);
    await openDetail();
    expect(await screen.findByText(/as of dispatch time/)).toBeTruthy();
    expect(screen.getByText('as-9')).toBeTruthy();
    expect(screen.getByText('ad-9')).toBeTruthy();
  });
});

describe('CO-SP-2/12 — the finalize picker is honest about briefs', () => {
  it('a failed briefs read shows the failure, not "No briefs found"', async () => {
    listBriefs.mockRejectedValue(new Error('boom'));
    await openPage();
    fireEvent.click(await screen.findByRole('button', { name: /finalize a brief/i }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Couldn't load briefs/)).toBeTruthy();
    expect(within(dialog).queryByText('No briefs found')).toBeNull();
  });

  it('kernel-less briefs are listed but disabled; the ready brief is preselected', async () => {
    await openPage();
    fireEvent.click(await screen.findByRole('button', { name: /finalize a brief/i }));
    const dialog = await screen.findByRole('dialog');
    const notReady = await within(dialog).findByRole('option', { name: /Draft brief/ }) as HTMLOptionElement;
    expect(notReady.disabled).toBe(true);
    // The preselection is STATE, so assert what the state does: the submit is
    // enabled and finalizes the ready brief. (A DOM `select.value` read is not
    // evidence — React's controlled <select> shows a fallback option when the
    // state matches none.)
    const submit = within(dialog).getByRole('button', { name: /^Finalize$/ }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(finalizeBrief).toHaveBeenCalledTimes(1));
    expect(finalizeBrief).toHaveBeenCalledWith('brief-a1');
  });
});

describe('CO-SP-3 — a finalize failure renders INSIDE the dialog', () => {
  it('the submit error appears in the modal, which stays open', async () => {
    finalizeBrief.mockRejectedValue(new Error('finalize exploded'));
    await openPage();
    fireEvent.click(await screen.findByRole('button', { name: /finalize a brief/i }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {});
    fireEvent.click(within(dialog).getByRole('button', { name: /^Finalize$/ }));
    // The failure renders inside the dialog (Modal's error region), not behind
    // the scrim.
    expect(await within(dialog).findByText('finalize exploded')).toBeTruthy();
  });
});

describe('CO-SP-4 — switching org resets the brief selection', () => {
  it('org B never inherits org A\'s briefId', async () => {
    listBriefs.mockImplementation(async (orgId?: string) => (orgId === 'org-b' ? BRIEFS_B : BRIEFS_A));
    await openPage();
    fireEvent.click(await screen.findByRole('button', { name: /finalize a brief/i }));
    const dialog = await screen.findByRole('dialog');
    const briefSelect = within(dialog).getByLabelText(/Brief/) as HTMLSelectElement;
    await act(async () => {});
    expect(briefSelect.value).toBe('brief-a1');
    fireEvent.change(within(dialog).getByLabelText(/Organization/), { target: { value: 'org-b' } });
    await act(async () => {});
    // The selection followed the org — it is org B's ready brief, never a
    // leftover org A id that would finalize the wrong org's brief. The DOM value
    // alone cannot prove that (a stale 'brief-a1' state matches no org-B option,
    // so React displays brief-b1 anyway) — the submit is the evidence.
    expect(briefSelect.value).toBe('brief-b1');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Finalize$/ }));
    await waitFor(() => expect(finalizeBrief).toHaveBeenCalledTimes(1));
    expect(finalizeBrief).toHaveBeenCalledWith('brief-b1');
    expect(finalizeBrief).not.toHaveBeenCalledWith('brief-a1');
  });
});

describe('CO-SP-3 — a failed status change is visible from the detail view', () => {
  it('renders the error in the detail branch', async () => {
    updateCampaign.mockRejectedValue(new Error('status write failed'));
    await openDetail();
    fireEvent.change(screen.getByLabelText(/Status/), { target: { value: 'paused' } });
    expect(await screen.findByText('status write failed')).toBeTruthy();
  });
});

describe('CO-SP-7 — the planned budget renders with its own currency', () => {
  it('a JPY budget renders whole (no /100 misread) via the currency formatter', async () => {
    listCampaigns.mockResolvedValue([{ ...CAMPAIGN, budget: { totalMinor: 500000, currency: 'JPY' } }]);
    await openDetail();
    // JPY has zero decimals: 500000 minor units IS ¥500,000 — a bare /100
    // would have shown 5,000.
    // The POSITIVE assertion discriminates: a /100 render would show ¥5,000.
    expect(await screen.findByText(/¥500,000/)).toBeTruthy();
  });

  it('a currencyless budget renders raw minor units and says so — no symbol, no /100', async () => {
    listCampaigns.mockResolvedValue([{ ...CAMPAIGN, budget: { totalMinor: 250000 } }]);
    await openDetail();
    expect(await screen.findByText(/250,000 minor units \(no currency recorded\)/)).toBeTruthy();
  });
});
