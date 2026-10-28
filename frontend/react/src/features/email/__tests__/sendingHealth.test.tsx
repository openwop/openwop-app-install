/**
 * ADR 0955 D7 — the Email page's sending-health card: a paused sender says so in words (not
 * colour alone), a manager can resume it after confirming, a non-manager is told who can, and a
 * failed read is a retryable error, never an empty card.
 *
 * Sabotage-witnessed: rendering the Resume button for `canResume:false` reds the second case;
 * swallowing the load failure (no notice) reds the third.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type * as EC from '../emailClient.js';

const getSendingHealth = vi.fn<typeof EC.getSendingHealth>();
const resumeSending = vi.fn<typeof EC.resumeSending>();
vi.mock('../emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSendingHealth: (...a: Parameters<typeof EC.getSendingHealth>) => getSendingHealth(...a),
  resumeSending: (...a: Parameters<typeof EC.resumeSending>) => resumeSending(...a),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: async () => true }));

const { EmailSendingHealthCard } = await import('../EmailSendingHealthCard.js');
const paused = (canResume: boolean): EC.SendingHealth => ({
  state: { paused: true, reason: 'complaints', pausedAt: '2026-10-20T00:00:00Z' },
  window: { sent: 1000, hardBounces: 3, complaints: 2 },
  thresholds: { minSends: 500, complaintRate: 0.001, hardBounceRate: 0.02 },
  canResume,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); getSendingHealth.mockReset(); resumeSending.mockReset(); });

describe('EmailSendingHealthCard', () => {
  it('a paused sender is named, and a manager resumes it', async () => {
    getSendingHealth.mockResolvedValueOnce(paused(true)).mockResolvedValueOnce({ ...paused(true), state: { paused: false } });
    resumeSending.mockResolvedValue(undefined);
    render(<EmailSendingHealthCard orgId="org:1" />);
    expect(await screen.findByText('Paused')).toBeTruthy();
    expect(screen.getByText(/Spam complaints went over the limit/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume sending' }));
    await waitFor(() => expect(resumeSending).toHaveBeenCalledWith('org:1'));
    expect(await screen.findByText('Sending')).toBeTruthy();
  });

  it('a non-manager sees who can resume, and no button', async () => {
    getSendingHealth.mockResolvedValue(paused(false));
    render(<EmailSendingHealthCard orgId="org:1" />);
    expect(await screen.findByText('An admin of this workspace can resume sending.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume sending' })).toBeNull();
  });

  it('a failed read is a retryable error', async () => {
    getSendingHealth.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(paused(false));
    render(<EmailSendingHealthCard orgId="org:1" />);
    expect(await screen.findByText('Could not load sending health.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Paused')).toBeTruthy();
  });

  it('a warming-up sender shows today’s ceiling (ADR 0955 P4b)', async () => {
    getSendingHealth.mockResolvedValue({ ...paused(false), state: null, warmup: { day: 3, cap: 250, remaining: 40 } });
    render(<EmailSendingHealthCard orgId="org:1" />);
    expect(await screen.findByText(/Warming up: day 3, up to 250 marketing emails today \(40 left\)/)).toBeTruthy();
  });

  it('a late read from the previous client cannot replace the current sending status', async () => {
    let finishOld = (_value: EC.SendingHealth): void => { throw new Error('Old request not started'); };
    const oldRead = new Promise<EC.SendingHealth>((resolve) => { finishOld = resolve; });
    getSendingHealth.mockImplementationOnce(() => oldRead).mockResolvedValueOnce({ ...paused(false), state: { paused: false } });
    const { rerender } = render(<EmailSendingHealthCard orgId="org:old" />);
    await waitFor(() => expect(getSendingHealth).toHaveBeenCalledWith('org:old'));
    rerender(<EmailSendingHealthCard orgId="org:current" />);
    expect(await screen.findByText('Sending')).toBeTruthy();
    await act(async () => { finishOld(paused(true)); });
    expect(screen.getByText('Sending')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume sending' })).toBeNull();
    expect(resumeSending).not.toHaveBeenCalled();
  });

  it('completion of a previous client resume cannot reload its health into the current client', async () => {
    let finishResume = (): void => { throw new Error('Resume not started'); };
    const pendingResume = new Promise<void>((resolve) => { finishResume = () => resolve(); });
    resumeSending.mockImplementationOnce(() => pendingResume);
    getSendingHealth.mockResolvedValueOnce(paused(true))
      .mockResolvedValueOnce({ ...paused(false), state: { paused: false } })
      .mockResolvedValueOnce(paused(true));
    const { rerender } = render(<EmailSendingHealthCard orgId="org:old" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume sending' }));
    await waitFor(() => expect(resumeSending).toHaveBeenCalledWith('org:old'));
    rerender(<EmailSendingHealthCard orgId="org:current" />);
    expect(await screen.findByText('Sending')).toBeTruthy();
    await act(async () => { finishResume(); });
    expect(screen.getByText('Sending')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume sending' })).toBeNull();
  });
});
