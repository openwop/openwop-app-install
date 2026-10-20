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
 * Sabotage that turns it red: render the form on a failed read; send
 * conversionActionTypes for google; drop the 1–90 guard; skip onSynced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import type { ConnectorSettings } from '../campaignConnectorsClient.js';

const getConnectorSettings = vi.fn();
const saveConnectorSettings = vi.fn();
const runBackfill = vi.fn();

vi.mock('../campaignConnectorsClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    getConnectorSettings: (...a: unknown[]) => getConnectorSettings(...a),
    saveConnectorSettings: (...a: unknown[]) => saveConnectorSettings(...a),
    runBackfill: (...a: unknown[]) => runBackfill(...a),
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
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save sync settings/i })).toBeNull();
  });

  it('saves the parsed account list and Meta action types; empty types clear to null', async () => {
    getConnectorSettings.mockResolvedValue(settings());
    saveConnectorSettings.mockImplementation(async (_o: string, _p: string, input: Record<string, unknown>) => settings(input as Partial<ConnectorSettings>));
    render(<SyncSettingsCard orgId="org-1" platforms={LIVE} onSynced={() => {}} />);
    const scope = await screen.findByLabelText(/campaigns to sync/i);
    fireEvent.change(scope, { target: { value: 'account' } });
    fireEvent.change(screen.getByLabelText(/ad account ids/i), { target: { value: 'act_1, act_2  act_3' } });
    fireEvent.click(screen.getByRole('button', { name: /save sync settings/i }));
    await waitFor(() => expect(saveConnectorSettings).toHaveBeenCalledTimes(1));
    expect(saveConnectorSettings).toHaveBeenCalledWith('org-1', 'meta', { syncScope: 'account', adAccountIds: ['act_1', 'act_2', 'act_3'], conversionActionTypes: null });
    expect(await screen.findByText(/sync settings saved/i)).toBeTruthy();
  });

  it('google never sends conversion action types', async () => {
    getConnectorSettings.mockImplementation(async (_o: string, p: string) => settings({ platform: p as 'meta' | 'google' }));
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
    fireEvent.change(days, { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: /start backfill/i }));
    expect(await screen.findByText(/from 1 to 90/i)).toBeTruthy();
    expect(runBackfill).not.toHaveBeenCalled();

    fireEvent.change(days, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /start backfill/i }));
    await waitFor(() => expect(runBackfill).toHaveBeenCalledWith('org-1', 'meta', 30));
    expect(await screen.findByText(/2 day\(s\) left/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /continue backfill/i })).toBeTruthy();
    expect(onSynced).toHaveBeenCalledTimes(1);
  });
});
