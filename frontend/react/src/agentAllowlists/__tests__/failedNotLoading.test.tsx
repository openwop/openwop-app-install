/**
 * AA-G1 — the fourth instance of "a failed read left at the LOADING sentinel"
 * (MEM-G1/PL-G1 #2584, CF-G2 #2588), here on the surface that says which tools
 * each agent is permitted to call.
 *
 * `agents === null` meant both "still loading" and "the read failed", so a
 * failure rendered the loading card indefinitely — an allowlist console that
 * never says whether it knows the allowlists.
 *
 * Sabotage-witnessed (wave 51): drop `loadFailed` from the first branch of
 * AgentAllowlistPanel → cases 1 + 2 red; make Retry a no-op → case 2 red; keep the
 * failed read's error Notice after a successful retry → case 2 red; render an empty
 * roster as failed OR as loading → case 3 red.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import type { AgentAllowlistRow } from '../agentAllowlistClient.js';

type Client = typeof import('../agentAllowlistClient.js');
const { listAgentAllowlists } = vi.hoisted(() => ({ listAgentAllowlists: vi.fn<Client['listAgentAllowlists']>() }));
vi.mock('../agentAllowlistClient.js', async (orig) => ({
  ...(await orig<Client>()),
  listAgentAllowlists,
}));

import { AgentAllowlistPanel } from '../AgentAllowlistPanel.js';

const ROW: AgentAllowlistRow = {
  agentId: 'agent.support', label: 'Support bot', persona: 'support', manifestAllowlist: [], override: null,
};

const mount = async (): Promise<void> => {
  render(<AgentAllowlistPanel />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  listAgentAllowlists.mockReset();
  listAgentAllowlists.mockResolvedValue([ROW]);
});

describe('AA-G1 — a failed allowlist read is not a loading one', () => {
  it('stops claiming it is still loading', async () => {
    listAgentAllowlists.mockRejectedValue(new Error('503'));
    await mount();
    expect(screen.getByText('Could not load the tool allowlists')).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('the retry recovers: the roster renders and the failed read\'s error is gone', async () => {
    listAgentAllowlists.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce([ROW]);
    await mount();
    expect(screen.getByText('503')).toBeTruthy(); // the failure's error is on screen first
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listAgentAllowlists).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Support bot' })).toBeTruthy();
    expect(screen.queryByText('Could not load the tool allowlists')).toBeNull();
    expect(screen.queryByText('503')).toBeNull();
  });

  it('a genuinely EMPTY roster still reads as empty, not failed or loading', async () => {
    // The failure mode of this fix is turning "no agents yet" into an error.
    listAgentAllowlists.mockResolvedValue([]);
    await mount();
    expect(screen.getByText('No agents found')).toBeTruthy();
    expect(screen.queryByText('Could not load the tool allowlists')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
