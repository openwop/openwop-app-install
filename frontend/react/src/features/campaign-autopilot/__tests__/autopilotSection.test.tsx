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
import { act, render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ getPreflight: vi.fn(), launchAutopilot: vi.fn(), listStoredRefs: vi.fn<() => Promise<string[]>>() }));
vi.mock('../../../byok/lib/byokClient.js', () => ({ listStoredRefs: h.listStoredRefs }));
vi.mock('../autopilotClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getPreflight: h.getPreflight, launchAutopilot: h.launchAutopilot }));

import { fireAuthChanged } from '../../../client/config.js';
import { AutopilotSection } from '../AutopilotSection.js';
import { AutopilotError, type Preflight } from '../autopilotClient.js';

const READY: Preflight = {
  campaignId: 'c1', ready: true,
  items: [
    { id: 'brief', status: 'ok', blocking: true },
    { id: 'brief-complete', status: 'ok', blocking: true },
    { id: 'brief-setup', status: 'warn', blocking: false, missing: ['brand', 'kb'] },
    { id: 'goal', status: 'warn', blocking: false },
  ],
};
const BLOCKED: Preflight = {
  campaignId: 'c1', ready: false,
  items: [
    { id: 'brief', status: 'ok', blocking: true },
    { id: 'brief-complete', status: 'missing', blocking: true, missing: ['productName', 'messaging.primaryValueProp'] },
    { id: 'ad-account', status: 'missing', blocking: true, missing: ['reconnect:meta'] },
    { id: 'goal', status: 'ok', blocking: false },
  ],
};

beforeEach(() => { h.getPreflight.mockReset(); h.launchAutopilot.mockReset(); h.listStoredRefs.mockReset().mockResolvedValue(['google:testing', 'anthropic:testing', 'google-vertex:team', 'billing:stripe-key']); });
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
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText(/The autopilot is running/)).toBeTruthy();
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    fireEvent.click(launchButton());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
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


it('dedicated Launch uses the real shared key picker and only explicitly selected name', async () => {
  h.getPreflight.mockResolvedValue({ preflight: READY, canLaunch: true });
  h.launchAutopilot.mockResolvedValue({ runId: 'r-key', campaignId: 'c1', reused: false });
  render(<AutopilotSection campaignId="c1" />);
  await screen.findByRole('list', { name: 'Preflight checklist' });
  fireEvent.click(launchButton());
  await screen.findByRole('option', { name: 'google:testing' });
  const key = screen.getByLabelText('AI key for this run');
  if (!(key instanceof HTMLSelectElement)) throw new Error('Actual key selector missing');
  expect(key.value).toBe('');
  expect(Array.from(key.options, option => option.value)).toEqual(['', 'google:testing', 'anthropic:testing']);
  expect(h.launchAutopilot).not.toHaveBeenCalled();
  fireEvent.change(key, { target: { value: 'google:testing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  await waitFor(() => expect(h.launchAutopilot).toHaveBeenCalledWith('c1', { credentialRef: 'google:testing' }));
  expect(await screen.findByText(/The autopilot is running/)).toBeTruthy();
});

it('a key-list failure still allows blank existing default and does not invent an empty vault', async () => {
  h.getPreflight.mockResolvedValue({ preflight: READY, canLaunch: true });
  h.listStoredRefs.mockRejectedValue(new Error('offline'));
  h.launchAutopilot.mockResolvedValue({ runId: 'r-default', campaignId: 'c1', reused: false });
  render(<AutopilotSection campaignId="c1" />);
  await screen.findByRole('list', { name: 'Preflight checklist' });
  fireEvent.click(launchButton());
  await screen.findByText('Stored keys could not be loaded. Retry before choosing a key.');
  expect(screen.queryByText(/No saved AI keys are available/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  await waitFor(() => expect(h.launchAutopilot).toHaveBeenCalledWith('c1'));
});

it('identity invalidation before the old modal submits cannot launch the old key', async () => {
  h.getPreflight.mockResolvedValue({ preflight: READY, canLaunch: true });
  render(<AutopilotSection campaignId="c1" />);
  await screen.findByRole('list', { name: 'Preflight checklist' });
  fireEvent.click(launchButton());
  await screen.findByRole('option', { name: 'google:testing' });
  const key = screen.getByLabelText('AI key for this run');
  fireEvent.change(key, { target: { value: 'google:testing' } });
  const form = key.closest('form');
  if (!form) throw new Error('Actual launch form missing');
  act(() => { fireAuthChanged(); fireEvent.submit(form); });
  expect(h.launchAutopilot).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByLabelText('AI key for this run')).toBeNull());
});

it('a pending launch from the old campaign cannot announce success in the next campaign', async () => {
  let resolveOld: ((result: { runId: string; campaignId: string; reused: boolean }) => void) | undefined;
  h.getPreflight.mockResolvedValue({ preflight: READY, canLaunch: true });
  h.launchAutopilot.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const view = render(<AutopilotSection campaignId="c1" />);
  await screen.findByRole('list', { name: 'Preflight checklist' });
  fireEvent.click(launchButton());
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect(h.launchAutopilot).toHaveBeenCalledWith('c1');
  view.rerender(<AutopilotSection campaignId="c2" />);
  await screen.findByRole('list', { name: 'Preflight checklist' });
  if (!resolveOld) throw new Error('Original launch did not start');
  const finish = resolveOld;
  await act(async () => finish({ runId: 'old-run', campaignId: 'c1', reused: false }));
  expect(screen.queryByText(/The autopilot is running/)).toBeNull();
  expect(launchButton().disabled).toBe(false);
});

it('a credential refusal is not mislabeled as missing client edit permission', async () => {
  h.getPreflight.mockResolvedValue({ preflight: READY, canLaunch: true });
  h.launchAutopilot.mockRejectedValue(new AutopilotError(403, 'Unavailable key', 'campaign_ai_key_forbidden'));
  render(<AutopilotSection campaignId="c1" />);
  await screen.findByRole('list', { name: 'Preflight checklist' });
  fireEvent.click(launchButton());
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect(await screen.findByText(/The selected AI key, provider or model could not be used/)).toBeTruthy();
  expect(screen.queryByText(/You need edit access/)).toBeNull();
});

it('parent identity guard also blocks blank/default submission from the old modal in the same act', async () => {
  h.getPreflight.mockResolvedValue({ preflight: READY, canLaunch: true });
  render(<AutopilotSection campaignId="c1" />);
  await screen.findByRole('list', { name: 'Preflight checklist' });
  fireEvent.click(launchButton());
  const key = screen.getByLabelText('AI key for this run');
  const form = key.closest('form');
  if (!form) throw new Error('Actual launch form missing');
  act(() => { fireAuthChanged(); fireEvent.submit(form); });
  expect(h.launchAutopilot).not.toHaveBeenCalled();
  await screen.findByRole('list', { name: 'Preflight checklist' });
});

it('late preflight from campaign A cannot replace the current B checklist or open its launcher', async () => {
  let finishOld: ((result: { preflight: Preflight; canLaunch: boolean }) => void) | undefined;
  h.getPreflight.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValueOnce({ preflight: { ...BLOCKED, campaignId: 'c2' }, canLaunch: true });
  const view = render(<AutopilotSection campaignId="c1" />);
  await waitFor(() => expect(h.getPreflight).toHaveBeenCalledWith('c1'));
  view.rerender(<AutopilotSection campaignId="c2" />);
  await screen.findByRole('list', { name: 'Preflight checklist' });
  if (!finishOld) throw new Error('Old preflight did not begin');
  const resolve = finishOld;
  await act(async () => resolve({ preflight: READY, canLaunch: true }));
  expect(launchButton().disabled).toBe(true);
  expect(screen.getByText(/Finish the required items/)).toBeTruthy();
  expect(screen.queryByLabelText('AI key for this run')).toBeNull();
});
