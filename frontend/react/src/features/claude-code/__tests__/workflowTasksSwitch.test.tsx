/**
 * ADR 0785 D7 — the per-device opt-in to workflow tasks on the devices page.
 * Turning it ON is consequential (unattended runs reach the machine), so it asks
 * first; turning it OFF is immediate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const list = vi.fn();
const setTasks = vi.fn();
vi.mock('../claudeCodeClient.js', async (orig) => ({
  ...(await orig<typeof import('../claudeCodeClient.js')>()),
  listDevices: (...a: unknown[]) => list(...a),
  setWorkflowTasks: (...a: unknown[]) => setTasks(...a),
}));

import { ClaudeCodeDevicesPage } from '../ClaudeCodeDevicesPage.js';

const device = (extra: Record<string, unknown> = {}) => ({
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
  });

  it('an allowed device shows Allowed, and Turn off acts immediately (no confirm)', async () => {
    list.mockResolvedValue([device({ workflowTasks: { enabledAt: '2026-10-05T04:00:00.000Z', enabledBy: 's' } })]);
    render(<MemoryRouter><ClaudeCodeDevicesPage /></MemoryRouter>);
    expect(await screen.findByText('Allowed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /stop workflow tasks on/i }));
    await waitFor(() => expect(setTasks).toHaveBeenCalledWith('ccd_XRqyAV_D6S1M', false));
  });
});
