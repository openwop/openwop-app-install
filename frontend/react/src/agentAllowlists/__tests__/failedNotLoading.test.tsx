/**
 * AA-G1 — the fourth instance of "a failed read left at the LOADING sentinel"
 * (MEM-G1/PL-G1 #2584, CF-G2 #2588), here on the surface that says which tools
 * each agent is permitted to call.
 *
 * `agents === null` meant both "still loading" and "the read failed", so a
 * failure rendered the loading card indefinitely — an allowlist console that
 * never says whether it knows the allowlists.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { listAgentAllowlists } = vi.hoisted(() => ({ listAgentAllowlists: vi.fn() }));
vi.mock('../agentAllowlistClient.js', async (orig) => ({
  ...(await orig<typeof import('../agentAllowlistClient.js')>()),
  listAgentAllowlists,
}));

import { AgentAllowlistPanel } from '../AgentAllowlistPanel.js';

const ROW = { rosterId: 'r1', persona: 'Support bot', label: 'Support bot', hasOverride: false };

const mount = async (): Promise<void> => {
  render(<AgentAllowlistPanel />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listAgentAllowlists.mockResolvedValue([ROW]);
});

describe('AA-G1 — a failed allowlist read is not a loading one', () => {
  it('stops claiming it is still loading', async () => {
    listAgentAllowlists.mockRejectedValue(new Error('503'));
    await mount();
    expect(screen.getByText('Could not load the tool allowlists')).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('the retry recovers', async () => {
    listAgentAllowlists.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce([ROW]);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(screen.queryByText('Could not load the tool allowlists')).toBeNull();
  });

  it('a genuinely EMPTY roster still reads as empty, not failed', async () => {
    // The failure mode of this fix is turning "no agents yet" into an error.
    listAgentAllowlists.mockResolvedValue([]);
    await mount();
    expect(screen.queryByText('Could not load the tool allowlists')).toBeNull();
  });
});
