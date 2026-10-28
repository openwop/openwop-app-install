/**
 * ADR 0961 P0 — the autopilot section on a campaign.
 *
 *   - a ready checklist names each item with a labeled status and enables Launch;
 *   - a blocked checklist names what is missing and keeps Launch disabled;
 *   - Launch says the run started (or that a recent one continues);
 *   - a 403 says edit access is needed; a failed read is said, never "ready".
 *
 * Sabotage: enabling the button regardless of `ready` reds the blocked case;
 * mapping a failed read to an empty checklist reds the failed-read case;
 * dropping the 403 branch reds the forbidden case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ getPreflight: vi.fn(), launchAutopilot: vi.fn() }));
vi.mock('../autopilotClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getPreflight: h.getPreflight, launchAutopilot: h.launchAutopilot }));

import { AutopilotSection } from '../AutopilotSection.js';
import { AutopilotError } from '../autopilotClient.js';

const READY = {
  campaignId: 'c1', ready: true,
  items: [
    { id: 'brief', status: 'ok', blocking: true },
    { id: 'brief-complete', status: 'ok', blocking: true },
    { id: 'brief-setup', status: 'warn', blocking: false, missing: ['brand', 'kb'] },
    { id: 'goal', status: 'warn', blocking: false },
  ],
};
const BLOCKED = {
  campaignId: 'c1', ready: false,
  items: [
    { id: 'brief', status: 'ok', blocking: true },
    { id: 'brief-complete', status: 'missing', blocking: true, missing: ['productName', 'messaging.primaryValueProp'] },
    { id: 'ad-account', status: 'missing', blocking: true, missing: ['reconnect:meta'] },
    { id: 'goal', status: 'ok', blocking: false },
  ],
};

beforeEach(() => { h.getPreflight.mockReset(); h.launchAutopilot.mockReset(); });
afterEach(cleanup);

const launchButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Launch autopilot' }) as HTMLButtonElement;

describe('AutopilotSection', () => {
  it('a ready checklist names each item with a labeled status and enables Launch', async () => {
    h.getPreflight.mockResolvedValue({ preflight: READY, canLaunch: true });
    render(<AutopilotSection campaignId="c1" />);
    const list = await screen.findByRole('list', { name: 'Preflight checklist' });
    expect(list.textContent).toContain('Brief is complete');
    expect(list.textContent).toContain('Recommended');
    expect(list.textContent).toContain('brand, knowledge collection');
    expect(launchButton().disabled).toBe(false);
  });

  it('a blocked checklist names what is missing and keeps Launch disabled', async () => {
    h.getPreflight.mockResolvedValue({ preflight: BLOCKED, canLaunch: true });
    render(<AutopilotSection campaignId="c1" />);
    const list = await screen.findByRole('list', { name: 'Preflight checklist' });
    expect(list.textContent).toContain('Missing');
    expect(list.textContent).toContain('required before launch');
    expect(list.textContent).toContain('product, value proposition');
    expect(list.textContent).toContain("The client's ad account is connected");
    expect(list.textContent).toContain('reconnect Meta');
    expect(launchButton().disabled).toBe(true);
    expect(h.launchAutopilot).not.toHaveBeenCalled();
  });

  it('Launch says the run started, or that a recent one continues', async () => {
    h.getPreflight.mockResolvedValue({ preflight: READY, canLaunch: true });
    h.launchAutopilot.mockResolvedValueOnce({ runId: 'r1', campaignId: 'c1', reused: false }).mockResolvedValueOnce({ runId: 'r1', campaignId: 'c1', reused: true });
    render(<AutopilotSection campaignId="c1" />);
    await screen.findByRole('list', { name: 'Preflight checklist' });
    fireEvent.click(launchButton());
    expect(await screen.findByText(/The autopilot is running/)).toBeTruthy();
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    fireEvent.click(launchButton());
    expect(await screen.findByText(/already launched moments ago/)).toBeTruthy();
    expect(h.launchAutopilot).toHaveBeenCalledWith('c1');
  });

  it('a read-only caller sees the checklist with Launch disabled and the reason', async () => {
    h.getPreflight.mockResolvedValue({ preflight: READY, canLaunch: false });
    render(<AutopilotSection campaignId="c1" />);
    await screen.findByRole('list', { name: 'Preflight checklist' });
    expect(screen.getByText(/launching needs edit access/)).toBeTruthy();
    expect(launchButton().disabled).toBe(true);
  });

  it('a 403 says edit access is needed', async () => {
    h.getPreflight.mockResolvedValue({ preflight: READY, canLaunch: true });
    h.launchAutopilot.mockRejectedValue(new AutopilotError(403, 'Missing required scope'));
    render(<AutopilotSection campaignId="c1" />);
    await screen.findByRole('list', { name: 'Preflight checklist' });
    fireEvent.click(launchButton());
    expect(await screen.findByText(/You need edit access/)).toBeTruthy();
  });

  it('a failed read is said, never shown as ready', async () => {
    h.getPreflight.mockRejectedValue(new Error('500'));
    render(<AutopilotSection campaignId="c1" />);
    expect((await screen.findAllByText('The checklist could not be loaded.')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('list', { name: 'Preflight checklist' })).toBeNull();
    expect(launchButton().disabled).toBe(true);
  });
});
