/**
 * ADR 0955 D7 — the Email page's sending-health card: a paused sender says so in words (not
 * colour alone), a manager can resume it after confirming, a non-manager is told who can, and a
 * failed read is a retryable error, never an empty card.
 *
 * Guards. A late read is held twice in its callback: the active org, and the request sequence.
 * A resume that finishes after the org changed is held three times: `resume()`'s org check,
 * `load()`'s entry check, and the read callback's check. The third stops the paint, so the last
 * case reads the toast and the read count rather than the screen.
 *
 * Sabotage (w76 probes): rendering the Resume button for `canResume:false` reds the second case;
 * swallowing the load failure reds the third; ignoring the confirm's answer reds the declined
 * case; removing both callback checks reds the late-read case; removing `resume()`'s check, or
 * both of the checks in front of the read, reds the last.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { t } from 'i18next';
import type * as EC from '../emailClient.js';

const h = vi.hoisted(() => ({
  confirm: vi.fn(async (): Promise<boolean> => true),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
const getSendingHealth = vi.fn<typeof EC.getSendingHealth>();
const resumeSending = vi.fn<typeof EC.resumeSending>();
vi.mock('../emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSendingHealth: (...a: Parameters<typeof EC.getSendingHealth>) => getSendingHealth(...a),
  resumeSending: (...a: Parameters<typeof EC.resumeSending>) => resumeSending(...a),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: h.confirm }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

const { EmailSendingHealthCard } = await import('../EmailSendingHealthCard.js');
const paused = (canResume: boolean): EC.SendingHealth => ({
  state: { paused: true, reason: 'complaints', pausedAt: '2026-10-20T00:00:00Z' },
  window: { sent: 1000, hardBounces: 3, complaints: 2 },
  thresholds: { minSends: 500, complaintRate: 0.001, hardBounceRate: 0.02 },
  canResume,
});
const resumeButton = { name: t('email:healthResume') };

afterEach(() => { cleanup(); vi.clearAllMocks(); getSendingHealth.mockReset(); resumeSending.mockReset(); });

describe('EmailSendingHealthCard', () => {
  it('a paused sender is named, and a manager resumes it', async () => {
    getSendingHealth.mockResolvedValueOnce(paused(true)).mockResolvedValueOnce({ ...paused(true), state: { paused: false } });
    resumeSending.mockResolvedValue(undefined);
    render(<EmailSendingHealthCard orgId="org:1" />);
    expect(await screen.findByText(t('email:healthPaused'))).toBeTruthy();
    expect(screen.getByText(t('email:healthPausedComplaints'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', resumeButton));
    await waitFor(() => expect(resumeSending).toHaveBeenCalledWith('org:1'));
    expect(await screen.findByText(t('email:healthSending'))).toBeTruthy();
  });

  it('a declined confirm leaves the sender paused', async () => {
    getSendingHealth.mockResolvedValue(paused(true));
    h.confirm.mockResolvedValueOnce(false);
    render(<EmailSendingHealthCard orgId="org:1" />);
    fireEvent.click(await screen.findByRole('button', resumeButton));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(resumeSending).not.toHaveBeenCalled();
    expect(screen.getByText(t('email:healthPaused'))).toBeTruthy();
  });

  it('a non-manager sees who can resume, and no button', async () => {
    getSendingHealth.mockResolvedValue(paused(false));
    render(<EmailSendingHealthCard orgId="org:1" />);
    expect(await screen.findByText(t('email:healthResumeManagersOnly'))).toBeTruthy();
    expect(screen.queryByRole('button', resumeButton)).toBeNull();
  });

  it('a failed read is a retryable error', async () => {
    getSendingHealth.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(paused(false));
    render(<EmailSendingHealthCard orgId="org:1" />);
    expect(await screen.findByText(t('email:healthLoadFailed'))).toBeTruthy();
    // Neither state, and no figures: the failure is not presented as a healthy sender.
    expect(screen.queryByText(t('email:healthSending'))).toBeNull();
    expect(screen.queryByText(t('email:healthPaused'))).toBeNull();
    expect(screen.queryByText(t('email:healthSent'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('email:healthRetry') }));
    expect(await screen.findByText(t('email:healthPaused'))).toBeTruthy();
  });

  it('a warming-up sender shows today’s ceiling (ADR 0955 P4b)', async () => {
    getSendingHealth.mockResolvedValue({ ...paused(false), state: null, warmup: { day: 3, cap: 250, remaining: 40 } });
    render(<EmailSendingHealthCard orgId="org:1" />);
    expect(await screen.findByText(t('email:healthWarmup', { day: '3', cap: '250', remaining: '40' }))).toBeTruthy();
  });

  it('a late read from the previous client cannot replace the current sending status', async () => {
    let finishOld = (_value: EC.SendingHealth): void => { throw new Error('Old request not started'); };
    const oldRead = new Promise<EC.SendingHealth>((resolve) => { finishOld = resolve; });
    getSendingHealth.mockImplementationOnce(() => oldRead).mockResolvedValueOnce({ ...paused(false), state: { paused: false } });
    const { rerender } = render(<EmailSendingHealthCard orgId="org:old" />);
    await waitFor(() => expect(getSendingHealth).toHaveBeenCalledWith('org:old'));
    rerender(<EmailSendingHealthCard orgId="org:current" />);
    expect(await screen.findByText(t('email:healthSending'))).toBeTruthy();
    await act(async () => { finishOld(paused(true)); });
    expect(screen.getByText(t('email:healthSending'))).toBeTruthy();
    expect(screen.queryByRole('button', resumeButton)).toBeNull();
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
    fireEvent.click(await screen.findByRole('button', resumeButton));
    await waitFor(() => expect(resumeSending).toHaveBeenCalledWith('org:old'));
    rerender(<EmailSendingHealthCard orgId="org:current" />);
    expect(await screen.findByText(t('email:healthSending'))).toBeTruthy();
    await act(async () => { finishResume(); });
    expect(screen.getByText(t('email:healthSending'))).toBeTruthy();
    expect(screen.queryByRole('button', resumeButton)).toBeNull();
    expect(getSendingHealth).toHaveBeenCalledTimes(2);
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });
});
