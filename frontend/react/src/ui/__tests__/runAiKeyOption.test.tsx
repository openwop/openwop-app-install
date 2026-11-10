/** ADR 0712 §Correction BYOK-2 (2026-11-05): real shared launch dialog; key names
 * only, no provider calls. Breaks if: a non-exact provider prefix (google-vertex) or a
 * managed/hidden provider's ref is offered; a blank choice sends a configurable; an
 * optional declared credentialRef stays in inputs or a second picker appears; a list
 * failure reads as zero keys; a late read or a pre-rerender submit survives an identity
 * change, or that change keeps the old selection; a non-AI dialog lists keys.
 * The late-read guard is doubled by the hook's `verified` gate, so case 5 asserts what
 * a stale write actually damages: the new workspace's list. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RunInputsDialog } from '../RunInputsForm.js';
import { fireAuthChanged } from '../../client/config.js';
const list = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
vi.mock('../../byok/lib/byokClient.js', () => ({ listStoredRefs: list }));
afterEach(cleanup);
function aiKeySelect(): HTMLSelectElement {
  const el = screen.getByLabelText('AI key for this run');
  if (!(el instanceof HTMLSelectElement)) throw new Error('AI key control is not a select');
  return el;
}
beforeEach(() => { list.mockReset().mockResolvedValue(['google:myndhyve-google', 'anthropic:myndhyve-api', 'billing:stripe-key', 'managed:openwop-free', 'subscription:github.copilot', 'google-vertex:team', 'openwop-free:team', 'minimax:team']); });
it('offers existing labeled keys and posts only selected run option while retaining unknown default inputs', async () => {
  const launch = vi.fn();
  render(<RunInputsDialog workflowName="Research" variables={[{ name: 'topic', required: true }]} initialInputs={{ topic: 'KickTodo', custom: { kept: true } }} aiKeyOption onRun={launch} onCancel={() => {}} />);
  await screen.findByLabelText('AI key for this run');
  await waitFor(() => expect(aiKeySelect().disabled).toBe(false));
  const select = aiKeySelect();
  expect([...select.options].map(o => o.value)).toEqual(['', 'google:myndhyve-google', 'anthropic:myndhyve-api']);
  expect(select.value).toBe('');
  fireEvent.change(select, { target: { value: 'google:myndhyve-google' } });
  fireEvent.change(screen.getByRole('textbox', { name: /^Topic/ }), { target: { value: 'DeckTalk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect(launch).toHaveBeenCalledWith({ topic: 'DeckTalk', custom: { kept: true } }, { version: 1, ai: { credentialRef: 'google:myndhyve-google' } });
});
it('blank remains no override for managed/default execution and zero keys is not a credential failure', async () => {
  list.mockResolvedValue([]); const launch = vi.fn();
  render(<RunInputsDialog workflowName="Managed" variables={[]} aiKeyOption onRun={launch} onCancel={() => {}} />);
  await screen.findByText(/No saved AI keys are available/);
  expect(screen.queryByText('Stored keys could not be loaded. Retry before choosing a key.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect(launch).toHaveBeenCalledWith({}, undefined);
});
it('keeps declared credential variable as sole picker and removes optional input rather than adding two choices', async () => {
  const launch = vi.fn();
  render(<RunInputsDialog workflowName="Declared" variables={[{ name: 'credentialRef', required: false }]} initialInputs={{ credentialRef: 'google:old', other: 9 }} aiKeyOption onRun={launch} onCancel={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText('Credential ref').tagName).toBe('SELECT'));
  const select = screen.getByLabelText('Credential ref');
  expect(screen.queryByLabelText('AI key for this run')).toBeNull();
  fireEvent.change(select, { target: { value: 'anthropic:myndhyve-api' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect(launch).toHaveBeenCalledWith({ other: 9 }, { version: 1, ai: { credentialRef: 'anthropic:myndhyve-api' } });
});
it('shows load error honestly while preserving no-override execution and retry', async () => {
  list.mockRejectedValueOnce(new Error('offline')); const launch = vi.fn();
  render(<RunInputsDialog workflowName="Research" variables={[]} aiKeyOption onRun={launch} onCancel={() => {}} />);
  await screen.findByText('Stored keys could not be loaded. Retry before choosing a key.');
  expect(screen.queryByText(/No saved AI keys/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Run' })); expect(launch).toHaveBeenCalledWith({}, undefined);
  launch.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('option', { name: 'google:myndhyve-google' });
  fireEvent.click(screen.getByRole('button', { name: 'Run' })); expect(launch).toHaveBeenCalledWith({}, undefined);
});
it('discards old workspace choices and late reads after an identity change', async () => {
  let oldRead: ((refs: string[]) => void) | undefined;
  list.mockImplementationOnce(() => new Promise(resolve => { oldRead = resolve; })).mockResolvedValueOnce(['anthropic:new-workspace']);
  const launch = vi.fn();
  render(<RunInputsDialog workflowName="Research" variables={[]} aiKeyOption onRun={launch} onCancel={() => {}} />);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  act(() => fireAuthChanged());
  await screen.findByRole('option', { name: 'anthropic:new-workspace' });
  if (!oldRead) throw new Error('First key-list read did not start');
  await act(async () => oldRead?.(['google:old-workspace']));
  expect(screen.queryByRole('option', { name: 'google:old-workspace' })).toBeNull();
  expect(screen.getByRole('option', { name: 'anthropic:new-workspace' })).toBeTruthy();
  expect(aiKeySelect().disabled).toBe(false);
  expect(aiKeySelect().value).toBe('');
});
it('leaves ordinary non-AI shared dialog behavior and unrelated default inputs intact', () => {
  const launch = vi.fn();
  render(<RunInputsDialog workflowName="Format" variables={[]} initialInputs={{ existing: 7 }} onRun={launch} onCancel={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect(launch).toHaveBeenCalledWith({ existing: 7 }, undefined); expect(list).not.toHaveBeenCalled();
});

it('blocks an old selected key when identity changes and the old form submits before React rerenders', async () => {
  const launch = vi.fn();
  render(<RunInputsDialog workflowName="Research" variables={[]} aiKeyOption onRun={launch} onCancel={() => {}} />);
  await screen.findByRole('option', { name: 'google:myndhyve-google' });
  const select = screen.getByLabelText('AI key for this run');
  fireEvent.change(select, { target: { value: 'google:myndhyve-google' } });
  const form = select.closest('form');
  if (!form) throw new Error('Actual launch form missing');
  act(() => { fireAuthChanged(); fireEvent.submit(form); });
  expect(launch).not.toHaveBeenCalled();
  // Wait for the NEW identity's list (the same key name is listed again): an empty
  // pending select reads '' whether or not the old choice was cleared.
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2));
  await screen.findByRole('option', { name: 'google:myndhyve-google' });
  await waitFor(() => expect(aiKeySelect().disabled).toBe(false));
  expect(aiKeySelect().value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect(launch).toHaveBeenCalledWith({}, undefined);
});
