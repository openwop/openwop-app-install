/**
 * ADR 0942 P4b — the campaign's open review windows.
 *   - lists each window with when it runs; Veto only where the server says canVeto;
 *   - a veto goes through the confirm dialog with its reason, then refreshes;
 *   - hidden when the toggle is off or nothing is waiting; a failed read is said.
 * What turns it red: offering Veto without canVeto, vetoing without the confirm,
 * dropping the reason, rendering an empty card, or a failed read shown as nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ listVetoWindows: vi.fn(), castVeto: vi.fn() }));
vi.mock('../autonomy/autonomyClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listVetoWindows: h.listVetoWindows, castVeto: h.castVeto }));
const { AutonomyDisabledError } = await import('../autonomy/autonomyClient.js');
const { default: VetoWindowsSection } = await import('../autonomy/VetoWindowsSection.js');

const win = (vetoId: string, canVeto: boolean) => ({ vetoId, actionClass: 'plan.approve', ruleId: 'plan.approve#default', deadline: '2026-10-20T16:00:00.000Z', runId: 'r1', canVeto });

beforeEach(() => { h.listVetoWindows.mockReset(); h.castVeto.mockReset(); });
afterEach(cleanup);

describe('VetoWindowsSection', () => {
  it('offers Veto only where the server allows it, and vetoes with the reason after confirming', async () => {
    h.listVetoWindows.mockResolvedValueOnce([win('v1', true), win('v2', false)]).mockResolvedValue([]);
    h.castVeto.mockResolvedValue(undefined);
    render(<VetoWindowsSection campaignId="c1" />);
    expect(await screen.findAllByText('Approve the plan')).toHaveLength(2);
    const buttons = screen.getAllByRole('button', { name: 'Veto' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'Wrong audience' } });
    expect(h.castVeto).not.toHaveBeenCalled();
    const dialogVeto = screen.getAllByRole('button', { name: 'Veto' }).at(-1)!;
    fireEvent.click(dialogVeto);
    await waitFor(() => expect(h.castVeto).toHaveBeenCalledWith('c1', 'v1', 'Wrong audience'));
    await waitFor(() => expect(h.listVetoWindows).toHaveBeenCalledTimes(2));
  });

  it('renders nothing when nothing is waiting, or the feature is off', async () => {
    h.listVetoWindows.mockResolvedValue([]);
    const a = render(<VetoWindowsSection campaignId="c1" />);
    await waitFor(() => expect(h.listVetoWindows).toHaveBeenCalled());
    await waitFor(() => expect(a.container.innerHTML).toBe(''));
    cleanup();
    h.listVetoWindows.mockRejectedValue(new AutonomyDisabledError('not enabled'));
    const b = render(<VetoWindowsSection campaignId="c1" />);
    await waitFor(() => expect(b.container.innerHTML).toBe(''));
  });

  it('a failed read is said, not shown as nothing waiting', async () => {
    h.listVetoWindows.mockRejectedValue(new Error('boom'));
    render(<VetoWindowsSection campaignId="c1" />);
    expect(await screen.findByText('The review windows could not be loaded.')).toBeTruthy();
  });
});
