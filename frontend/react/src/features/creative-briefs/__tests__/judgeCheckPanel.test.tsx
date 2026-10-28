/**
 * ADR 0945 P2 — the judge check runs on the key and model the admin picks.
 * It prefills from the workspace's default AI provider, sends exactly the
 * chosen {provider, model, credentialRef}, and reports each case and who
 * judged. A wrong case or a refusal is said plainly, never shown as a pass.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type * as Client from '../creativeBriefsClient.js';

const runJudgeCheck = vi.hoisted(() => vi.fn<typeof Client.runJudgeCheck>());
const refs = vi.hoisted(() => ({ list: ['claude-key', 'gem-key'] as string[] }));
const listStoredRefs = vi.hoisted(() => vi.fn(async () => refs.list));
vi.mock('../creativeBriefsClient.js', () => ({ runJudgeCheck }));
vi.mock('../../../byok/lib/byokClient.js', () => ({
  listStoredRefs,
  getAiDefault: async () => ({ provider: 'google', model: 'gemini-vision', credentialRef: 'gem-key' }),
}));

import { JudgeCheckPanel } from '../JudgeCheckPanel.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); refs.list = ['claude-key', 'gem-key']; });

const report = (overrides: Partial<Client.JudgeCheckReport> = {}): Client.JudgeCheckReport => ({
  provider: 'anthropic', model: 'claude-x', route: 'byok-chosen', rulesetVersion: 'fid-a-1', checkedAt: '2026-10-27T00:00:00Z',
  calls: 4, maxCalls: 8, completed: true, passed: true,
  cases: [
    { id: 'identity', expected: 'pass', judged: 'pass', outcome: 'pass', passed: true },
    { id: 'logo-swap', expected: 'fail', judged: 'pass', outcome: 'pass', passed: false },
  ],
  ...overrides,
});

describe('JudgeCheckPanel', () => {
  it('fetches nothing about keys until it is opened', () => {
    render(<JudgeCheckPanel orgId="o1" />);
    expect(screen.getByRole('button', { name: 'Set up the check' })).toBeTruthy();
    expect(listStoredRefs).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Run the check' })).toBeNull();
  });

  it('prefills the default, sends the chosen key and model, and reports each case', async () => {
    runJudgeCheck.mockResolvedValue(report({ passed: false }));
    render(<JudgeCheckPanel orgId="o1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up the check' }));
    const model = await screen.findByRole('textbox', { name: /Model/ });
    await waitFor(() => expect((model as HTMLInputElement).value).toBe('gemini-vision'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'anthropic' } });
    fireEvent.change(model, { target: { value: ' claude-x ' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'AI key' }), { target: { value: 'claude-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run the check' }));
    await waitFor(() => expect(runJudgeCheck).toHaveBeenCalledWith('o1', { provider: 'anthropic', model: 'claude-x', credentialRef: 'claude-key' }));
    expect(await screen.findAllByText('The judge got 1 of 2 cases wrong.')).not.toHaveLength(0);
    expect(screen.getByText('Logo swapped')).toBeTruthy();
    expect(screen.getByText('Wrong')).toBeTruthy();
    expect(screen.getByText('Judged by anthropic claude-x in 4 calls.')).toBeTruthy();
  });

  it('a stopped run shows what the provider said, as its status and codes', async () => {
    runJudgeCheck.mockResolvedValue(report({ completed: false, passed: false, calls: 1, cases: [
      { id: 'identity', expected: 'pass', passed: false, error: 'provider_unavailable', providerError: { status: 429, codes: ['RESOURCE_EXHAUSTED'] } },
    ] }));
    render(<JudgeCheckPanel orgId="o1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up the check' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: /Model/ }) as HTMLInputElement).value).toBe('gemini-vision'));
    fireEvent.click(screen.getByRole('button', { name: 'Run the check' }));
    expect(await screen.findByText('Provider said: 429 RESOURCE_EXHAUSTED')).toBeTruthy();
  });

  it('a refusal is announced, with no report', async () => {
    runJudgeCheck.mockRejectedValue(new Error('Only an admin of this client can do this.'));
    render(<JudgeCheckPanel orgId="o1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up the check' }));
    const run = await screen.findByRole('button', { name: 'Run the check' });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);
    expect(await screen.findAllByText('Only an admin of this client can do this.')).not.toHaveLength(0);
    expect(screen.queryByText(/The judge got/)).toBeNull();
  });

  it('with no AI keys it says to add one, and offers no run', async () => {
    refs.list = [];
    render(<JudgeCheckPanel orgId="o1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up the check' }));
    expect(await screen.findByText('Add an AI provider key under Keys first, then choose it here.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run the check' })).toBeNull();
  });
});
