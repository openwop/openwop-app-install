/**
 * ADR 0945 Q1 — the client's edit-mode opt-in checkbox. It reflects the
 * server's setting, saves through PUT, and a refusal (a non-admin: 403) is an
 * announced message — the box never claims a state the server did not store.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type * as Client from '../creativeBriefsClient.js';

const getGroundingSettings = vi.hoisted(() => vi.fn<typeof Client.getGroundingSettings>());
const setGroundingSettings = vi.hoisted(() => vi.fn<typeof Client.setGroundingSettings>());
vi.mock('../creativeBriefsClient.js', () => ({ getGroundingSettings, setGroundingSettings, runJudgeCheck: vi.fn() }));
vi.mock('../../../byok/lib/byokClient.js', () => ({ listStoredRefs: async () => [], getAiDefault: async () => null }));

import GroundingSettingsPanel from '../GroundingSettingsPanel.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('GroundingSettingsPanel', () => {
  it('shows the stored setting and saves a change', async () => {
    getGroundingSettings.mockResolvedValue({ editModeEnabled: false });
    setGroundingSettings.mockResolvedValue({ editModeEnabled: true });
    render(<GroundingSettingsPanel orgId="o1" />);
    const box = await screen.findByRole('checkbox', { name: 'Allow edit mode for this client' });
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(setGroundingSettings).toHaveBeenCalledWith('o1', true));
    await waitFor(() => expect((box as HTMLInputElement).checked).toBe(true));
  });

  it('a refused save leaves the box as stored and says why', async () => {
    getGroundingSettings.mockResolvedValue({ editModeEnabled: false });
    setGroundingSettings.mockRejectedValue(new Error('Only an admin of this client can change this.'));
    render(<GroundingSettingsPanel orgId="o1" />);
    const box = await screen.findByRole('checkbox');
    fireEvent.click(box);
    expect(await screen.findAllByText('Only an admin of this client can change this.')).not.toHaveLength(0);
    expect((box as HTMLInputElement).checked).toBe(false);
  });
});
