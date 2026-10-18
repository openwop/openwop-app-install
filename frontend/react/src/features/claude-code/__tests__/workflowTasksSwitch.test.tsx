/**
 * ADR 0785 D7 — the per-device opt-in to workflow tasks on the devices page.
 * Turning it ON is consequential (unattended runs reach the machine), so it asks
 * first; turning it OFF is immediate.
 *
 * Sabotage-witnessed (w52): Allow… calling the API directly, the confirm sending
 * enabled=false, Turn off opening the confirm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Client = typeof import('../claudeCodeClient.js');
const list = vi.fn<Client['listDevices']>();
const setTasks = vi.fn<Client['setWorkflowTasks']>();
vi.mock('../claudeCodeClient.js', async (orig) => ({
  ...(await orig<Client>()),
  listDevices: (...a: Parameters<Client['listDevices']>) => list(...a),
  setWorkflowTasks: (...a: Parameters<Client['setWorkflowTasks']>) => setTasks(...a),
}));

import { ClaudeCodeDevicesPage } from '../ClaudeCodeDevicesPage.js';
import type { DeviceView } from '../claudeCodeClient.js';

const device = (extra: Partial<DeviceView> = {}): DeviceView => ({
  deviceId: 'ccd_XRqyAV_D6S1M', tenantId: 't', subject: 's', label: 'MacBook-Pro-48.local', platform: 'darwin-arm64',
  createdAt: '2026-10-05T03:00:00.000Z', consentVersion: 'v1', consentHash: 'h', status: 'active', online: true, ...extra,
});

describe('workflow tasks switch (ADR 0785 D7)', () => {
  beforeEach(() => { list.mockReset(); setTasks.mockReset(); setTasks.mockResolvedValue(undefined); });
  afterEach(cleanup);

  it('Allow… asks first, and only the confirm calls the API with enabled=true', async () => {
    list.mockResolvedValue([device()]);
    render(<MemoryRouter><ClaudeCodeDevicesPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /allow workflow tasks on/i }));
    expect(setTasks).not.toHaveBeenCalled();
    expect(await screen.findByText(/without you watching/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^allow workflow tasks$/i }));
    await waitFor(() => expect(setTasks).toHaveBeenCalledWith('ccd_XRqyAV_D6S1M', true));
    // The confirm closes and the list is re-read (the device's new state comes from the server).
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/without you watching/i)).toBeNull();
  });

  it('an allowed device shows Allowed, and Turn off acts immediately (no confirm)', async () => {
    list.mockResolvedValue([device({ workflowTasks: { enabledAt: '2026-10-05T04:00:00.000Z', enabledBy: 's' } })]);
    render(<MemoryRouter><ClaudeCodeDevicesPage /></MemoryRouter>);
    expect(await screen.findByText('Allowed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /stop workflow tasks on/i }));
    await waitFor(() => expect(setTasks).toHaveBeenCalledWith('ccd_XRqyAV_D6S1M', false));
  });
});
