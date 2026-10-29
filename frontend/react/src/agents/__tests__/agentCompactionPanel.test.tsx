/**
 * ADR 0999 D7 (`TOCU-2`) — the per-agent `lossy` compaction opt-in has an editor
 * and an indicator, saves without wiping its siblings, and shows a viewer the
 * setting without a form it cannot save.
 *
 * Sabotage witnessed 2026-10-28:
 *  - `buildCompactionInput` starting from `{}` instead of the loaded
 *    `configParameters` → the merge case reds (voice + minChars wiped).
 *  - dropping the `if (!enabled) return null` guard → the toggle-off case reds.
 *  - rendering the Save button regardless of `canWrite` → the viewer case reds.
 *  - deriving the chip from the DRAFT instead of the saved profile → the save
 *    case reds (TOC2UX-8: the chip claimed "Lossy" before anything was saved).
 *  - setting `state` to 'ready' in the load catch → the failed-load case reds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

type RosterClient = typeof import('../rosterClient.js');
const { getAgentProfile, putAgentProfile, canWrite, featureOn } = vi.hoisted(() => ({
  getAgentProfile: vi.fn<RosterClient['getAgentProfile']>(),
  putAgentProfile: vi.fn<RosterClient['putAgentProfile']>(),
  canWrite: { value: true },
  featureOn: { value: true },
}));
vi.mock('../rosterClient.js', async (orig) => ({
  ...(await orig<typeof import('../rosterClient.js')>()),
  getAgentProfile, putAgentProfile,
}));
vi.mock('../agentWriteAccess.js', async (orig) => ({
  ...(await orig<typeof import('../agentWriteAccess.js')>()),
  useAgentWriteAccess: () => canWrite.value,
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureVisible: () => (id?: string) => (id === 'tool-output-compaction' ? featureOn.value : true),
}));

import { AgentCompactionPanel } from '../AgentCompactionPanel.js';
import type { AgentProfile } from '../rosterClient.js';

const PROFILE: AgentProfile = {
  profileId: 'p-1', tenantId: 't1', roleKey: 'custom',
  autonomy: { level: 'review', specLevel: 'draft-only' },
  // Siblings this panel does not own: a voice, and an API-set compaction floor.
  configParameters: { voice: { provider: 'minimax', voiceId: 'v1' }, compaction: { minChars: 200 } },
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

const mount = async (): Promise<void> => {
  render(<AgentCompactionPanel rosterId="agent-1" />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  canWrite.value = true;
  featureOn.value = true;
  getAgentProfile.mockResolvedValue(PROFILE);
  putAgentProfile.mockImplementation(async (_id, input) => ({ ...PROFILE, configParameters: input.configParameters ?? undefined } as AgentProfile));
});

describe('AgentCompactionPanel (ADR 0999 D7)', () => {
  it('renders nothing while the toggle is off — a control that does nothing is a false claim', async () => {
    featureOn.value = false;
    await mount();
    expect(screen.queryByText('Tool-output compaction')).toBeNull();
    expect(getAgentProfile).not.toHaveBeenCalled();
  });

  it('shows the current mode as a chip (the indicator TOCU-2 said was missing)', async () => {
    await mount();
    expect(screen.getByText('Lossless')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('turning lossy on saves ONLY its keys and keeps every sibling; the chip changes only once SAVED', async () => {
    await mount();
    // The warning is the checkbox's description, so a screen reader hears it with the control.
    const box = screen.getByRole('checkbox');
    expect(box.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(box.getAttribute('aria-describedby')!)?.textContent).toMatch(/Lossy removes information/);
    // Save is offered only for a change.
    expect((screen.getByRole('button', { name: 'Save compaction' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(box); });
    // TOC2UX-8 — unsaved: the indicator still states what the agent RUNS.
    expect(screen.getByText('Lossless')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Rows kept at the start'), { target: { value: '2' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save compaction' })); });
    expect(putAgentProfile).toHaveBeenCalledTimes(1);
    const input = putAgentProfile.mock.calls[0]![1];
    expect(input.configParameters).toEqual({
      voice: { provider: 'minimax', voiceId: 'v1' },
      compaction: { minChars: 200, lossy: true, head: 2 },
    });
    expect(screen.getByText('Lossy')).toBeTruthy();
  });

  it('an invalid row count disables Save instead of saving a default the user did not ask for', async () => {
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('checkbox')); });
    fireEvent.change(screen.getByLabelText('Rows kept at the end'), { target: { value: '-1' } });
    expect((screen.getByRole('button', { name: 'Save compaction' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Enter a whole number, 0 or more.')).toBeTruthy();
  });

  it('a viewer sees the setting, every control disabled, and no Save', async () => {
    canWrite.value = false;
    getAgentProfile.mockResolvedValue({ ...PROFILE, configParameters: { compaction: { lossy: true, head: 4 } } });
    await mount();
    expect(screen.getByText('Lossy')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Rows kept at the start') as HTMLInputElement).value).toBe('4');
    expect(screen.queryByRole('button', { name: 'Save compaction' })).toBeNull();
  });

  it('a failed load says so and offers a retry that recovers (never a silently disabled form)', async () => {
    getAgentProfile.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(PROFILE);
    await mount();
    expect(screen.getByText('The compaction setting could not be loaded.')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /retry|try again/i })); });
    expect(screen.queryByText('The compaction setting could not be loaded.')).toBeNull();
    expect(screen.getByText('Lossless')).toBeTruthy();
  });
});

