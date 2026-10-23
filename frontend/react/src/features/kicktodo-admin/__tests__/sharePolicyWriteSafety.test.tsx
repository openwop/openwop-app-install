/**
 * KTD-1 + KTD-2 (KickTodo UX-ASSESSMENT) — the share-policy money write.
 *
 * KTD-1: `setSharePolicy` OVERWRITES the revenue-share rate every future sale
 * accrues at, and it went out on one click. It now asks first through the app's
 * confirm dialog, naming the rate in force and the new one; cancelling writes
 * nothing.
 *
 * KTD-2: every payout-panel failure reduced to one boolean ("That payout action
 * failed. Check the value…"), so a 409 — another operator changed the policy or
 * the run first — read as a bad value. A 409 now gets its own localized copy and
 * the panel re-reads, so the operator sees what is now in force. Raw server text
 * never reaches the page.
 *
 * The same 409 rule covers both run actions (confirm AND cancel): each says the
 * run changed elsewhere and re-reads the runs.
 *
 * Breaks it (sabotage-witnessed): removing the confirm (the cancel case writes);
 * the confirm body dropping the current rate; collapsing the 409 back into the
 * generic failure; not re-reading after a conflict (the new rate never shows);
 * the 409 copy used as a catch-all (the 500 case); a run action not re-reading.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { messages as en } from '../i18n/en.js';
import { messages as commonEn } from '../../../i18n/locales/en/common.js';
import type * as SeatClient from '../../../client/kicktodoSeatClient.js';
import type { PayoutRun, SharePolicy } from '../../../client/kicktodoSeatClient.js';

const api = vi.hoisted(() => ({
  getSharePolicy: vi.fn<typeof SeatClient.getSharePolicy>(),
  listPayoutRuns: vi.fn<typeof SeatClient.listPayoutRuns>(),
  setSharePolicy: vi.fn<typeof SeatClient.setSharePolicy>(),
  confirmPayoutRun: vi.fn<typeof SeatClient.confirmPayoutRun>(),
  cancelPayoutRun: vi.fn<typeof SeatClient.cancelPayoutRun>(),
}));
vi.mock('../../../client/kicktodoSeatClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/kicktodoSeatClient.js')>()),
  ...api,
}));

import { AdminCommercePage } from '../AdminCommercePage.js';
import { ConfirmRoot } from '../../../ui/confirm.js';
import { PayoutRequestError } from '../../../client/kicktodoSeatClient.js';

const POLICY_20: SharePolicy = { shareBps: 2000, version: 3 };
const POLICY_25: SharePolicy = { shareBps: 2500, version: 4 };
const OPEN_RUN: PayoutRun = {
  runId: 'run-1', state: 'open', createdAt: '2026-10-01T00:00:00Z',
  entries: [{ authorSubject: 'author-a', currency: 'usd', totalMinor: 1200, rowCount: 2 }],
};
const CONFIRMED_RUN: PayoutRun = { ...OPEN_RUN, state: 'confirmed', reference: 'po_123' };
const CANCELED_RUN: PayoutRun = { ...OPEN_RUN, state: 'canceled' };

const renderPage = () => render(<MemoryRouter><AdminCommercePage /><ConfirmRoot /></MemoryRouter>);

async function typeRateAndSet(bps: string): Promise<void> {
  await waitFor(() => expect(screen.getByText('Author share: 20%')).toBeTruthy());
  fireEvent.change(screen.getByLabelText(en.payoutPolicyLabel), { target: { value: bps } });
  fireEvent.click(screen.getByRole('button', { name: en.payoutPolicySetCta }));
}

beforeEach(() => {
  api.getSharePolicy.mockResolvedValue(POLICY_20);
  api.listPayoutRuns.mockResolvedValue([]);
  api.setSharePolicy.mockResolvedValue(POLICY_25);
});
// resetAllMocks, not clearAllMocks: a case's mockRejectedValue on a run action
// must not survive into the next case (beforeEach re-arms the defaults).
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('AdminCommercePage — share policy write (KTD-1)', () => {
  it('asks first, naming the rate it replaces; Cancel writes nothing', async () => {
    renderPage();
    await typeRateAndSet('2500');
    const dialog = await screen.findByRole('dialog', { name: en.payoutPolicyConfirmTitle });
    expect(within(dialog).getByText(/^From 20% to 25% of each sale/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: commonEn.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.setSharePolicy).not.toHaveBeenCalled();
  });

  it('confirming writes the typed basis points', async () => {
    renderPage();
    await typeRateAndSet('2500');
    const dialog = await screen.findByRole('dialog', { name: en.payoutPolicyConfirmTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: en.payoutPolicyConfirmCta }));
    await waitFor(() => expect(api.setSharePolicy).toHaveBeenCalledWith(2500));
    expect(api.setSharePolicy).toHaveBeenCalledTimes(1);
  });
});

describe('AdminCommercePage — specific conflict copy (KTD-2)', () => {
  it('a 409 on the policy write says a concurrent change won, and shows the rate now in force', async () => {
    api.setSharePolicy.mockRejectedValue(new PayoutRequestError('share policy set', 409));
    renderPage();
    await typeRateAndSet('3000');
    const dialog = await screen.findByRole('dialog');
    api.getSharePolicy.mockResolvedValue(POLICY_25); // the other operator's write — only the re-read sees it
    fireEvent.click(within(dialog).getByRole('button', { name: en.payoutPolicyConfirmCta }));
    await waitFor(() => expect(screen.getByText(en.payoutPolicyConflict)).toBeTruthy());
    expect(screen.queryByText(en.payoutError)).toBeNull();
    await waitFor(() => expect(screen.getByText('Author share: 25%')).toBeTruthy());
    // Raw error text never reaches the page (PayoutRequestError's message is "share policy set failed: 409").
    expect(document.body.textContent).not.toContain('failed: 409');
  });

  it('a non-409 failure keeps the generic copy (the conflict copy is not a catch-all)', async () => {
    api.setSharePolicy.mockRejectedValue(new PayoutRequestError('share policy set', 500));
    renderPage();
    await typeRateAndSet('3000');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.payoutPolicyConfirmCta }));
    await waitFor(() => expect(screen.getByText(en.payoutError)).toBeTruthy());
    expect(screen.queryByText(en.payoutPolicyConflict)).toBeNull();
    expect(document.body.textContent).not.toContain('failed: 500');
  });

  it('a 409 confirming a run says it changed elsewhere and re-reads the runs', async () => {
    api.listPayoutRuns.mockResolvedValue([OPEN_RUN]);
    api.confirmPayoutRun.mockRejectedValue(new PayoutRequestError('payout confirm', 409));
    renderPage();
    fireEvent.change(await screen.findByLabelText(en.payoutReferenceLabel), { target: { value: 'po_999' } });
    api.listPayoutRuns.mockResolvedValue([CONFIRMED_RUN]);
    fireEvent.click(screen.getByRole('button', { name: en.payoutConfirmCta }));
    await waitFor(() => expect(screen.getByText(en.payoutRunConflict)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(en.payoutRunConfirmed)).toBeTruthy());
    expect(api.confirmPayoutRun).toHaveBeenCalledWith('run-1', 'po_999');
    expect(screen.queryByText(en.payoutError)).toBeNull();
    expect(document.body.textContent).not.toContain('failed: 409');
  });

  it('a 409 cancelling a run says it changed elsewhere and re-reads the runs', async () => {
    api.listPayoutRuns.mockResolvedValue([OPEN_RUN]);
    api.cancelPayoutRun.mockRejectedValue(new PayoutRequestError('payout cancel', 409));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: en.payoutCancelCta }));
    const dialog = await screen.findByRole('dialog', { name: en.payoutCancelConfirmTitle });
    api.listPayoutRuns.mockResolvedValue([CANCELED_RUN]); // the other operator's action — only the re-read sees it
    fireEvent.click(within(dialog).getByRole('button', { name: en.payoutCancelCta }));
    await waitFor(() => expect(screen.getByText(en.payoutRunConflict)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(en.payoutRunCanceled)).toBeTruthy());
    expect(api.cancelPayoutRun).toHaveBeenCalledWith('run-1');
    expect(screen.queryByText(en.payoutError)).toBeNull();
  });
});
