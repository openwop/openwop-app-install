/**
 * ADR 0945 P2 — the judge check runs on the key and model the admin picks.
 * It reads nothing about keys until opened, prefills from the workspace's
 * default AI provider, sends exactly the chosen {provider, model, credentialRef}
 * (the key's NAME, never its value), and reports each case and who judged. A
 * wrong case, a stopped run or a refusal is said plainly, never shown as a pass.
 *
 * The run is stubbed at the FETCH level (`POST …/fidelity/judge-check`), so the
 * route and body are asserted and a refusal is the server's body.
 *
 * Sabotage (witnessed, wave 78): read keys or the default before opening →
 * case 1 red; skip the provider prefill, send the untrimmed model, call the
 * wrong route, show a miss as a pass, or drop the "Wrong" chip → case 2 red;
 * drop the provider status, or show a stopped run as anything but stopped →
 * case 3 red; replace the server's refusal with generic copy → case 4 red;
 * offer a run with no keys → case 5 red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { config } from '../../../client/config.js';
import type { JudgeCheckReport } from '../creativeBriefsClient.js';

const refs = vi.hoisted(() => ({ list: ['claude-key', 'gem-key'] as string[] }));
const byok = vi.hoisted(() => ({
  listStoredRefs: vi.fn(async (): Promise<string[]> => refs.list),
  getAiDefault: vi.fn(async () => ({ provider: 'google' as const, model: 'gemini-vision', credentialRef: 'gem-key' })),
}));
vi.mock('../../../byok/lib/byokClient.js', () => byok);

import { JudgeCheckPanel } from '../JudgeCheckPanel.js';

const RUN_URL = `${config.baseUrl}/host/openwop-app/creative-briefs/orgs/o1/fidelity/judge-check`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const requests = (): Array<[string, string | undefined, unknown]> =>
  fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body ? JSON.parse(String(init.body)) : undefined]);

beforeEach(() => {
  refs.list = ['claude-key', 'gem-key'];
  byok.listStoredRefs.mockClear(); byok.getAiDefault.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const report = (overrides: Partial<JudgeCheckReport> = {}): JudgeCheckReport => ({
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
    expect(byok.listStoredRefs).not.toHaveBeenCalled();
    expect(byok.getAiDefault).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Run the check' })).toBeNull();
  });

  it('prefills the default, sends the chosen key and model, and reports each case', async () => {
    fetchMock.mockResolvedValueOnce(json(200, report({ passed: false })));
    render(<JudgeCheckPanel orgId="o1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up the check' }));
    const model = await screen.findByRole('textbox', { name: /Model/ });
    await waitFor(() => expect((model as HTMLInputElement).value).toBe('gemini-vision'));
    // The whole default is prefilled, not only the model.
    expect((screen.getByRole('combobox', { name: 'Provider' }) as HTMLSelectElement).value).toBe('google');
    expect((screen.getByRole('combobox', { name: 'AI key' }) as HTMLSelectElement).value).toBe('gem-key');
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'anthropic' } });
    fireEvent.change(model, { target: { value: ' claude-x ' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'AI key' }), { target: { value: 'claude-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run the check' }));
    expect(await screen.findAllByText('The judge got 1 of 2 cases wrong.')).not.toHaveLength(0);
    expect(requests()).toEqual([[RUN_URL, 'POST', { provider: 'anthropic', model: 'claude-x', credentialRef: 'claude-key' }]]);
    expect(screen.getByText('Logo swapped')).toBeTruthy();
    expect(screen.getByText('Wrong')).toBeTruthy();
    expect(screen.getByText('Judged by anthropic claude-x in 4 calls.')).toBeTruthy();
  });

  // A combined failure can catch a logo change that the independent AI judge missed.
  // Keep the server's Wrong result and make its two returned verdicts observable.
  it.each(['pass', 'needs_review'] as const)('explains a wrong judge %s even when the combined result correctly fails', async (judged) => {
    fetchMock.mockResolvedValueOnce(json(200, report({ passed: false, cases: [
      { id: 'identity', expected: 'pass', judged: 'pass', outcome: 'pass', passed: true },
      { id: 'logo-swap', expected: 'fail', judged, outcome: 'fail', passed: false },
      { id: 'extra-part', expected: 'fail', judged: 'fail', outcome: 'fail', passed: true },
    ] })));
    render(<JudgeCheckPanel orgId="o1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up the check' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: /Model/ }) as HTMLInputElement).value).toBe('gemini-vision'));
    fireEvent.click(screen.getByRole('button', { name: 'Run the check' }));
    const logo = await screen.findByText('Logo swapped');
    const logoRow = logo.closest('li');
    if (!logoRow) throw new Error('Logo result row missing');
    expect(within(logoRow).getByText('Wrong')).toBeTruthy();
    expect(within(logoRow).getByText(`expected fail, judge ${judged === 'needs_review' ? 'review' : 'pass'}, combined fail`)).toBeTruthy();
    const correctRow = screen.getByText('Extra part added').closest('li');
    if (!correctRow) throw new Error('Correct result row missing');
    expect(within(correctRow).getByText('Right')).toBeTruthy();
    expect(within(correctRow).getByText('expected fail, judge fail, combined fail')).toBeTruthy();
    expect(screen.getAllByText('The judge got 1 of 3 cases wrong.')).not.toHaveLength(0);
    expect(screen.getByText('A case is right only when both the AI judge and the combined checks match the expected result.')).toBeTruthy();
    expect(requests()).toEqual([[RUN_URL, 'POST', { provider: 'google', model: 'gemini-vision', credentialRef: 'gem-key' }]]);
  });

  it('a stopped run shows what the provider said, as its status and codes', async () => {
    fetchMock.mockResolvedValueOnce(json(200, report({ completed: false, passed: false, calls: 1, cases: [
      { id: 'identity', expected: 'pass', passed: false, error: 'provider_unavailable', providerError: { status: 429, codes: ['RESOURCE_EXHAUSTED'] } },
    ] })));
    render(<JudgeCheckPanel orgId="o1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up the check' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: /Model/ }) as HTMLInputElement).value).toBe('gemini-vision'));
    fireEvent.click(screen.getByRole('button', { name: 'Run the check' }));
    expect(await screen.findByText('Provider said: 429 RESOURCE_EXHAUSTED')).toBeTruthy();
    expect(screen.getAllByText('The check stopped before every case was answered. The model did not reply, or its reply could not be read.')).not.toHaveLength(0);
    expect(screen.queryByText(/The judge got/)).toBeNull();
  });

  it('a refusal is announced, with no report', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: 'forbidden', message: 'Only an admin of this client can do this.' }));
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
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
