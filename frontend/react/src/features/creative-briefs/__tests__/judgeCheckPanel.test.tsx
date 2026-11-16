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
 * 01899e81f (ADR 0945): each case row shows the expected result, the AI
 * judge's own verdict and the combined verdict, and its Right/Wrong chip is the
 * SERVER's `passed` — a combined fail can be right while the judge alone said
 * pass or review, and that case is still Wrong.
 *
 * Every case waits for the run to settle (the results list, or the one notice)
 * and then asserts exact values, so a break reds on a value, not a lookup
 * timeout.
 *
 * Sabotage (witnessed, wave 78; re-probed wave 116 as w116g3-jc-*): read keys
 * before opening → case 1 red; skip the provider or key prefill, send the
 * untrimmed model, call the wrong route, show a miss as a pass, or drop the
 * "Wrong" chip → case 2 red; derive the chip from outcome-vs-expected, show the
 * combined verdict as the judge's (or the reverse), count misses the same way,
 * or drop the results help → the two "explains a wrong judge" rows red; drop the
 * provider status, or show a stopped run as anything but stopped → the stopped
 * case red; replace the server's refusal with generic copy → the refusal case
 * red; offer a run with no keys → the no-keys case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
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
/** Every notice on the panel as [text, tone]. */
const notices = (root: HTMLElement): Array<[string | null, string]> =>
  Array.from(root.querySelectorAll('.alert'), (n) => [n.textContent, ['success', 'warning', 'info', 'error'].find((v) => n.classList.contains(v)) ?? n.className]);
/** Each result row as [case label, chip text, chip class, result line]. */
const resultRows = (): Array<[string | null, string | null, string, string | null]> =>
  within(screen.getByRole('list', { name: 'Check results' })).getAllByRole('listitem').map((li) => {
    const spans = li.querySelectorAll(':scope > span');
    return [spans[1]?.textContent ?? null, spans[0]?.textContent ?? null, spans[0]?.className ?? '', spans[2]?.textContent ?? null];
  });
const settledReport = async (): Promise<void> => {
  await waitFor(() => expect(screen.queryAllByRole('list', { name: 'Check results' })).toHaveLength(1));
};
const runButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Run the check' }) as HTMLButtonElement;

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
    const { container } = render(<JudgeCheckPanel orgId="o1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up the check' }));
    const model = await screen.findByRole('textbox', { name: /Model/ });
    await waitFor(() => expect((model as HTMLInputElement).value).toBe('gemini-vision'));
    // The whole default is prefilled, not only the model.
    expect((screen.getByRole('combobox', { name: 'Provider' }) as HTMLSelectElement).value).toBe('google');
    expect((screen.getByRole('combobox', { name: 'AI key' }) as HTMLSelectElement).value).toBe('gem-key');
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'anthropic' } });
    fireEvent.change(model, { target: { value: ' claude-x ' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'AI key' }), { target: { value: 'claude-key' } });
    fireEvent.click(runButton());
    await settledReport();
    expect(requests()).toEqual([[RUN_URL, 'POST', { provider: 'anthropic', model: 'claude-x', credentialRef: 'claude-key' }]]);
    expect(notices(container)).toEqual([['The judge got 1 of 2 cases wrong.', 'warning']]);
    expect(resultRows().map(([label, chip, cls]) => [label, chip, cls])).toEqual([
      ['Unchanged product', 'Right', 'chip chip--success'],
      ['Logo swapped', 'Wrong', 'chip chip--danger'],
    ]);
    expect(screen.getByText('Judged by anthropic claude-x in 4 calls.').tagName).toBe('P');
  });

  // A combined failure can catch a logo change that the independent AI judge missed.
  // Keep the server's Wrong result and make its two returned verdicts observable.
  it.each(['pass', 'needs_review'] as const)('explains a wrong judge %s even when the combined result correctly fails', async (judged) => {
    fetchMock.mockResolvedValueOnce(json(200, report({ passed: false, cases: [
      { id: 'identity', expected: 'pass', judged: 'pass', outcome: 'pass', passed: true },
      { id: 'logo-swap', expected: 'fail', judged, outcome: 'fail', passed: false },
      { id: 'extra-part', expected: 'fail', judged: 'fail', outcome: 'fail', passed: true },
    ] })));
    const { container } = render(<JudgeCheckPanel orgId="o1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up the check' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: /Model/ }) as HTMLInputElement).value).toBe('gemini-vision'));
    // The whole default landed (the key too), so the run is offered.
    expect(runButton().disabled).toBe(false);
    fireEvent.click(runButton());
    await settledReport();
    const judgeSaid = judged === 'needs_review' ? 'review' : 'pass';
    expect(resultRows()).toEqual([
      ['Unchanged product', 'Right', 'chip chip--success', 'expected pass, judge pass, combined pass'],
      // The combined verdict matches the expected fail, but the judge alone did not: Wrong.
      ['Logo swapped', 'Wrong', 'chip chip--danger', `expected fail, judge ${judgeSaid}, combined fail`],
      ['Extra part added', 'Right', 'chip chip--success', 'expected fail, judge fail, combined fail'],
    ]);
    expect(notices(container)).toEqual([['The judge got 1 of 3 cases wrong.', 'warning']]);
    expect(screen.getAllByText('A case is right only when both the AI judge and the combined checks match the expected result.')).toHaveLength(1);
    expect(requests()).toEqual([[RUN_URL, 'POST', { provider: 'google', model: 'gemini-vision', credentialRef: 'gem-key' }]]);
  });

  it('a stopped run shows what the provider said, as its status and codes', async () => {
    fetchMock.mockResolvedValueOnce(json(200, report({ completed: false, passed: false, calls: 1, cases: [
      { id: 'identity', expected: 'pass', passed: false, error: 'provider_unavailable', providerError: { status: 429, codes: ['RESOURCE_EXHAUSTED'] } },
    ] })));
    const { container } = render(<JudgeCheckPanel orgId="o1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up the check' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: /Model/ }) as HTMLInputElement).value).toBe('gemini-vision'));
    expect(runButton().disabled).toBe(false);
    fireEvent.click(runButton());
    await settledReport();
    expect(notices(container)).toEqual([['The check stopped before every case was answered. The model did not reply, or its reply could not be read.', 'warning']]);
    const [row] = within(screen.getByRole('list', { name: 'Check results' })).getAllByRole('listitem');
    expect(Array.from(row!.querySelectorAll(':scope > span'), (n) => n.textContent)).toEqual([
      'Wrong', 'Unchanged product', 'the model did not reply', 'Provider said: 429 RESOURCE_EXHAUSTED',
    ]);
    expect(screen.queryByText(/The judge got/)).toBeNull();
  });

  it('a refusal is announced, with no report', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: 'forbidden', message: 'Only an admin of this client can do this.' }));
    const { container } = render(<JudgeCheckPanel orgId="o1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up the check' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: /Model/ }) as HTMLInputElement).value).toBe('gemini-vision'));
    expect(runButton().disabled).toBe(false);
    fireEvent.click(runButton());
    // Wait for the one notice (the refusal, or any generic copy), then read it.
    await waitFor(() => expect(container.querySelectorAll('.alert')).toHaveLength(1));
    expect(notices(container)).toEqual([['Only an admin of this client can do this.', 'warning']]);
    expect(screen.queryAllByRole('list', { name: 'Check results' })).toHaveLength(0);
    expect(screen.queryByText(/The judge got/)).toBeNull();
  });

  it('with no AI keys it says to add one, and offers no run', async () => {
    refs.list = [];
    const { container } = render(<JudgeCheckPanel orgId="o1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up the check' }));
    await waitFor(() => expect(byok.listStoredRefs).toHaveBeenCalled());
    // Let both resolved reads land, then read the settled panel.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(notices(container)).toEqual([['Add an AI provider key under Keys first, then choose it here.', 'info']]);
    expect(screen.queryByRole('button', { name: 'Run the check' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
