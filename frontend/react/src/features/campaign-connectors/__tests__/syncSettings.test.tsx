/**
 * ADR 0907 D3 — the live-sync settings + backfill card.
 *
 *  - a failed settings read is a stated failure, never the defaults presented
 *    as saved values;
 *  - save sends the parsed account list and, for Meta only, the action types
 *    (an empty list clears them back to the defaults with `null`);
 *  - the backfill refuses a day count outside 1–90 before calling, reports
 *    progress with a Continue action, and refreshes the KPI on progress/done.
 *
 * Sabotage-witnessed (wave 55/56 probes, each red here): defaults rendered as
 * saved on a failed read; conversionActionTypes hard-coded to null, or sent
 * for google; the account list split on commas only; the card rendered with no
 * live reader; either bound of the 1–90 guard moved; onSynced skipped on
 * progress; Continue offered only on rate_limited.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import type { ConnectorSettings } from '../campaignConnectorsClient.js';

type Client = typeof import('../campaignConnectorsClient.js');
const { getConnectorSettings, saveConnectorSettings, runBackfill } = vi.hoisted(() => ({
  getConnectorSettings: vi.fn<Client['getConnectorSettings']>(),
  saveConnectorSettings: vi.fn<Client['saveConnectorSettings']>(),
  runBackfill: vi.fn<Client['runBackfill']>(),
}));

vi.mock('../campaignConnectorsClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    getConnectorSettings,
    saveConnectorSettings,
    runBackfill,
  };
});

import { SyncSettingsCard } from '../SyncSettingsCard.js';
import type { LiveSyncPlatform } from '../campaignConnectorsClient.js';

const LIVE: LiveSyncPlatform[] = ['meta', 'google'];

const settings = (over: Partial<ConnectorSettings> = {}): ConnectorSettings => ({
  orgId: 'org-1', platform: 'meta', syncScope: 'dispatched', adAccountIds: [], updatedAt: '', ...over,
});

describe('SyncSettingsCard (ADR 0907 D3)', () => {
  beforeEach(() => { getConnectorSettings.mockReset(); saveConnectorSettings.mockReset(); runBackfill.mockReset(); });
  afterEach(() => cleanup());

  it('a failed settings read says so and shows no form', async () => {
    getConnectorSettings.mockRejectedValue(new Error('boom'));
    render(<SyncSettingsCard orgId="org-1" platforms={LIVE} onSynced={() => {}} />);
    // The literal: the same alert slot also carries save/backfill errors.
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load the sync settings. Nothing shown here is a saved value.");
    expect(screen.queryByRole('button', { name: /save sync settings/i })).toBeNull();
  });

  it('saves the parsed account list and Meta action types; empty types clear to null', async () => {
    getConnectorSettings.mockResolvedValue(settings());
    saveConnectorSettings.mockImplementation(async (_o, _p, input) => settings({
      syncScope: input.syncScope, adAccountIds: input.adAccountIds,
      ...(input.conversionActionTypes ? { conversionActionTypes: input.conversionActionTypes } : {}),
    }));
    render(<SyncSettingsCard orgId="org-1" platforms={LIVE} onSynced={() => {}} />);
    const scope = await screen.findByLabelText(/campaigns to sync/i);
    fireEvent.change(scope, { target: { value: 'account' } });
    fireEvent.change(screen.getByLabelText(/ad account ids/i), { target: { value: 'act_1, act_2  act_3' } });
    // Non-empty Meta action types are sent parsed.
    fireEvent.change(screen.getByLabelText(/conversion action types/i), { target: { value: 'offsite_conversion.fb_pixel_purchase, lead' } });
    fireEvent.click(screen.getByRole('button', { name: /save sync settings/i }));
    await waitFor(() => expect(saveConnectorSettings).toHaveBeenCalledTimes(1));
    expect(saveConnectorSettings).toHaveBeenLastCalledWith('org-1', 'meta', {
      syncScope: 'account', adAccountIds: ['act_1', 'act_2', 'act_3'],
      conversionActionTypes: ['offsite_conversion.fb_pixel_purchase', 'lead'],
    });
    expect(await screen.findByText(/sync settings saved/i)).toBeTruthy();
    // Emptied, they clear back to the defaults with null.
    fireEvent.change(screen.getByLabelText(/conversion action types/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save sync settings/i }));
    await waitFor(() => expect(saveConnectorSettings).toHaveBeenCalledTimes(2));
    expect(saveConnectorSettings).toHaveBeenLastCalledWith('org-1', 'meta', { syncScope: 'account', adAccountIds: ['act_1', 'act_2', 'act_3'], conversionActionTypes: null });
  });

  it('google never sends conversion action types', async () => {
    getConnectorSettings.mockImplementation(async (_o, p) => settings({ platform: p }));
    saveConnectorSettings.mockImplementation(async () => settings({ platform: 'google' }));
    render(<SyncSettingsCard orgId="org-1" platforms={LIVE} onSynced={() => {}} />);
    fireEvent.change(await screen.findByLabelText(/^platform/i), { target: { value: 'google' } });
    await waitFor(() => expect(getConnectorSettings).toHaveBeenLastCalledWith('org-1', 'google'));
    expect(await screen.findByLabelText(/ad account ids/i)).toBeTruthy();
    expect(screen.queryByLabelText(/conversion action types/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /save sync settings/i }));
    await waitFor(() => expect(saveConnectorSettings).toHaveBeenCalled());
    expect(saveConnectorSettings.mock.calls[0]?.[2]).not.toHaveProperty('conversionActionTypes');
  });

  it('renders nothing when no reader is live, and offers only the live platforms', async () => {
    getConnectorSettings.mockResolvedValue(settings());
    const { container } = render(<SyncSettingsCard orgId="org-1" platforms={[]} onSynced={() => {}} />);
    expect(container.innerHTML).toBe('');
    cleanup();
    render(<SyncSettingsCard orgId="org-1" platforms={['meta', 'linkedin']} onSynced={() => {}} />);
    const select = await screen.findByLabelText(/^platform/i);
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual(['meta', 'linkedin']);
  });

  it('backfill: refuses days outside 1–90 without calling, then reports progress, offers Continue, refreshes the KPI', async () => {
    getConnectorSettings.mockResolvedValue(settings());
    runBackfill.mockResolvedValue({ outcome: 'progress', remainingDays: 2, imported: 40, windowsDone: 4, failures: [], truncated: false });
    const onSynced = vi.fn();
    render(<SyncSettingsCard orgId="org-1" platforms={LIVE} onSynced={onSynced} />);
    const days = await screen.findByLabelText(/days to backfill/i);
    // Both bounds: 0 (below) and 120 (above) are refused without a call. The
    // handler reaches runBackfill synchronously on the click, so the call
    // absence is the per-bound discriminator (the alert from 0 persists).
    for (const bad of ['0', '120']) {
      fireEvent.change(days, { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: /start backfill/i }));
      expect(runBackfill).not.toHaveBeenCalled();
      expect((await screen.findByRole('alert')).textContent).toBe('Enter a whole number of days from 1 to 90.');
    }

    fireEvent.change(days, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /start backfill/i }));
    await waitFor(() => expect(runBackfill).toHaveBeenCalledWith('org-1', 'meta', 30));
    expect(await screen.findByText(/2 day\(s\) left/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /continue backfill/i })).toBeTruthy();
    expect(onSynced).toHaveBeenCalledTimes(1);
  });
});
