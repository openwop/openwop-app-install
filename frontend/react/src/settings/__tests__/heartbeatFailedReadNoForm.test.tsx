/**
 * A failed read must not hand you a form that writes over what it could not read.
 *
 * `{view === null && !error ? <SkeletonRows/> : (…<form/>)}` was written
 * DELIBERATELY to avoid a permanent skeleton on error — correct about the
 * skeleton, and it unveiled the form. On a failed read the fields fell back to
 * this component's initial defaults (`off`, 10 min, no budget), which look like a
 * real configuration, and `onSave` sends a FULL replacement:
 *
 *   saveHeartbeatSettings({ status, enabledUntil, hostDefaultIntervalMs, runBudgetPerHour })
 *
 * So one click turned the workspace's autonomous work loop OFF, from a network
 * error. THE FIX FOR ONE VARIANT OF THIS FAMILY CREATED ANOTHER — worth
 * remembering the next time a `&& !error` looks like a tidy way to stop a spinner.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { getHeartbeatSettings, saveHeartbeatSettings } = vi.hoisted(() => ({
  getHeartbeatSettings: vi.fn(), saveHeartbeatSettings: vi.fn(),
}));
vi.mock('../../client/heartbeatAdminClient.js', async (orig) => ({
  ...(await orig<typeof import('../../client/heartbeatAdminClient.js')>()),
  getHeartbeatSettings, saveHeartbeatSettings,
}));

import { HeartbeatSettingsPage } from '../HeartbeatSettingsPage.js';

/** A workspace with the loop ON — the state a default-filled save would destroy. */
const LIVE = {
  config: {
    status: 'on' as const,
    hostDefaultIntervalMs: 30 * 60_000,
    runBudgetPerHour: 12,
    enabledUntil: null,
  },
  overridden: false,
};

const mount = async (): Promise<void> => {
  render(<HeartbeatSettingsPage />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  getHeartbeatSettings.mockResolvedValue(LIVE);
  saveHeartbeatSettings.mockResolvedValue(LIVE);
});

describe('a failed heartbeat read never offers a Save', () => {
  it('does not render the form at all', async () => {
    getHeartbeatSettings.mockRejectedValue(new Error('503'));
    await mount();
    // The mechanism, not the symptom: no form means no submit path exists.
    expect(document.querySelector('form')).toBeNull();
    expect(saveHeartbeatSettings).not.toHaveBeenCalled();
  });

  it('says the read failed, rather than showing a plausible configuration', async () => {
    getHeartbeatSettings.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('Could not load the heartbeat settings');
  });

  it('does not sit on the skeleton either — the original bug, still fixed', async () => {
    getHeartbeatSettings.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.querySelector('.skeleton')).toBeNull();
  });

  it('the retry recovers into the REAL config, not the defaults', async () => {
    getHeartbeatSettings.mockRejectedValueOnce(new Error('503')).mockResolvedValue(LIVE);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(document.querySelector('form')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Could not load the heartbeat settings');
  });

  it('a SUCCESSFUL read still gives a working, savable form', async () => {
    // The failure mode of this fix: an admin who can never change the cadence.
    await mount();
    expect(document.querySelector('form')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Could not load the heartbeat settings');
  });
});
