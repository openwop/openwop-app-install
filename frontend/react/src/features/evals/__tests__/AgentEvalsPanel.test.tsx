/**
 * ADR 0889 P6 — the agent workspace Evals tab. The client is mocked (the real
 * `AgentEvalsRequestError` is kept, since the editor branches on it), so these
 * are pure component cases:
 *   - a tenant with no suites gets the designed first-run empty state + CTA;
 *   - a history row opens its scorecard, which renders trials (c/n + pass@k /
 *     pass^k), trajectory counts, fixture misses and the regression verdict;
 *   - a server 400 lands inline on the control that owns `details.field`;
 *   - the run lane is called with the REGISTRY agent id, never a rosterId.
 *
 * Eval honesty (w52): a failed run is asserted Failed in the history row AND the
 * scorecard header (the header chip forced to `passed` was invisible in round 1),
 * and a declined recording consent writes nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../agent/agentEvalsClient.js', async (importActual) => {
  const actual = await importActual<typeof import('../agent/agentEvalsClient.js')>();
  return {
    ...actual,
    getEvalCapability: vi.fn(),
    listEvalSuites: vi.fn(),
    listEvalRuns: vi.fn(),
    putEvalSuite: vi.fn(),
    deleteEvalSuite: vi.fn(),
    getEvalProgress: vi.fn(),
    getEvalSummary: vi.fn(),
    startEvalRun: vi.fn(),
    getCapture: vi.fn(),
    setCapture: vi.fn(),
    promoteRunToSuite: vi.fn(),
  };
});
vi.mock('../../../client/chatSessionsClient.js', () => ({ fetchModelCapabilities: vi.fn() }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn() }));
vi.mock('../../../chat/composerSeed.js', () => ({ stageComposerDraft: vi.fn() }));

import {
  AgentEvalsRequestError, getCapture, getEvalCapability, getEvalProgress, listEvalRuns, listEvalSuites, promoteRunToSuite, putEvalSuite, setCapture, startEvalRun,
  type EvalProgress, type StoredSuite,
} from '../agent/agentEvalsClient.js';
import { AgentEvalsPanel } from '../agent/AgentEvalsPanel.js';
import { fetchModelCapabilities } from '../../../client/chatSessionsClient.js';
import { confirm } from '../../../ui/confirm.js';
import { stageComposerDraft } from '../../../chat/composerSeed.js';
import { Route, Routes, useLocation } from 'react-router-dom';

const AGENT = 'vendor.openwop-app.support';

const suite: StoredSuite = {
  ref: 'support.evals.refunds@1.0.0',
  suite: { suiteId: 'support.evals.refunds', version: '1.0.0', modes: ['golden'], trials: { count: 3, k: 3, passRule: 'mean' }, tasks: [{ taskId: 'refund-policy', input: 'q', expected: { kind: 'golden', match: { strategy: 'contains', value: '30 days' } } }] },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  locked: true,
};

const completed: EvalProgress = {
  runId: 'run-2',
  status: 'completed',
  suiteRef: suite.ref,
  agentId: AGENT,
  progress: {
    'refund-policy': {
      0: { score: 1, passed: true, scoreLabel: 'pass', evaluatorType: 'golden', costUsd: 0.01, latencyMs: 900, efficiency: { toolCallCount: 2, modelCallCount: 1, inputTokens: 10, outputTokens: 5 }, fixtureMissCount: 0 },
      1: { score: 0, passed: false, scoreLabel: 'fail', evaluatorType: 'golden', costUsd: 0.01, latencyMs: 1100, efficiency: { toolCallCount: 3, modelCallCount: 1, inputTokens: 10, outputTokens: 5 }, fixtureMissCount: 1, detail: 'Answer omitted the 30-day window.' },
      2: { score: 1, passed: true, scoreLabel: 'pass', evaluatorType: 'golden', costUsd: 0.01, latencyMs: 1000, efficiency: { toolCallCount: 2, modelCallCount: 1, inputTokens: 10, outputTokens: 5 }, fixtureMissCount: 0 },
    },
  },
  summary: {
    suiteId: 'support.evals.refunds', suiteVersion: '1.0.0', aggregateScore: 0.67, passed: false, taskCount: 1, passedCount: 0, totalCostUsd: 0.03,
    tasks: [{
      taskId: 'refund-policy', score: 0.67, passed: false, costUsd: 0.03, latencyMs: 1000, fixtureMissCount: 1,
      trials: { n: 3, passedCount: 2, meanScore: 0.67, passAtK: 1, passHatK: 0 },
      trajectory: { mode: 'in-order', matched: false, expectedCount: 2, observedCount: 3, matchedCount: 1, forbiddenCount: 1 },
    }],
    trialStats: { k: 3, passAtK: 1, passHatK: 0 },
    regression: { baselineRunId: 'run-1', scoreDelta: -0.33, verdict: 'regressed', method: 'paired-sign', alpha: 0.05, pairedTaskCount: 1 },
  },
  error: null,
};

/** Renders the current location so a navigation is observable. */
function Where(): JSX.Element { const l = useLocation(); return <output data-testid="where">{`${l.pathname}${l.search}`}</output>; }
const renderPanel = (opts: { canWrite?: boolean; onDirtyChange?: (d: boolean) => void; at?: string } = {}) => render(
  <MemoryRouter initialEntries={[opts.at ?? '/agents/a?tab=evals']}>
    <Routes>
      <Route path="*" element={<><AgentEvalsPanel agentId={AGENT} persona="Iris" canWrite={opts.canWrite ?? true} {...(opts.onDirtyChange ? { onDirtyChange: opts.onDirtyChange } : {})} /><Where /></>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.mocked(getEvalCapability).mockResolvedValue({ modes: ['golden', 'rubric', 'regression'], maxTasksPerSuite: 100, maxCostUsdPerSuite: 5, trajectory: true, trials: { maxTrials: 10 }, fixtureMatching: true, regressionVerdict: true });
  vi.mocked(listEvalSuites).mockResolvedValue([]);
  vi.mocked(listEvalRuns).mockResolvedValue({ items: [] });
  vi.mocked(getCapture).mockResolvedValue({ agentId: AGENT, enabled: false, runs: [] });
  vi.mocked(fetchModelCapabilities).mockResolvedValue([]);
  vi.mocked(confirm).mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('AgentEvalsPanel (ADR 0889 P6)', () => {
  it('shows the first-run empty state with a Create suite action', async () => {
    renderPanel();
    expect(await screen.findByText('No eval suites yet')).toBeTruthy();
    expect(screen.getByText(/An eval suite is a set of test tasks/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Create suite/ })).toBeTruthy();
    expect(listEvalSuites).toHaveBeenCalledWith(AGENT);
    expect(listEvalRuns).toHaveBeenCalledWith(AGENT);
  });

  it('opens a history run as a scorecard with trials, trajectory and the regression verdict', async () => {
    vi.mocked(listEvalSuites).mockResolvedValue([suite]);
    vi.mocked(listEvalRuns).mockResolvedValue({ items: [
      { runId: 'run-2', status: 'completed', createdAt: '2026-10-02T00:00:00Z', suiteRef: suite.ref, agentId: AGENT, baselineRunId: 'run-1', aggregateScore: 0.67, passed: false, taskCount: 1, passedCount: 0, regression: completed.summary!.regression! },
    ] });
    vi.mocked(getEvalProgress).mockResolvedValue(completed);
    renderPanel();

    const history = await screen.findByRole('table', { name: 'Eval runs for this agent, newest first' });
    const historyRow = within(history).getByText('Regressed').closest('tr')!;
    // Eval honesty: a failed run reads as Failed in the history row too.
    expect(within(historyRow).getByText('Failed')).toBeTruthy();
    fireEvent.click(historyRow);

    const scorecard = await screen.findByRole('table', { name: 'Per-task results' });
    // …and in the scorecard HEADER (the run-level verdict), never Passed anywhere.
    const header = document.getElementById('ae-scorecard-run-2')!.parentElement!;
    expect(within(header).getByText('Failed')).toBeTruthy();
    expect(screen.queryByText('Passed')).toBeNull();
    expect(getEvalProgress).toHaveBeenCalledWith('run-2');
    const row = within(scorecard).getByText('refund-policy').closest('tr')!;
    expect(within(row).getByText('2/3 passed')).toBeTruthy();
    expect(within(row).getByText('pass@k 100% · pass^k 0%')).toBeTruthy();
    expect(within(row).getByText('1/2 matched')).toBeTruthy();
    expect(within(row).getByText('1 forbidden call')).toBeTruthy();
    expect(within(row).getByText('Failed')).toBeTruthy();
    expect(within(row).getByText('Answer omitted the 30-day window.')).toBeTruthy();
    // The regression chip renders in the scorecard header as well as the history row.
    expect(screen.getAllByText('Regressed').length).toBe(2);
    // A9 — the run viewer is linked; the synthetic workflow never is.
    expect(screen.getByRole('link', { name: /Open run/ }).getAttribute('href')).toBe('/runs/run-2');
    expect(screen.queryByRole('link', { name: /builder/i })).toBeNull();
    // EVUX-4 — a failed suite opens the ONE chat scoped to the Agent Author (the
    // agent that can read eval results), with a staged draft naming this run.
    fireEvent.click(screen.getByRole('button', { name: /Ask why/ }));
    expect(stageComposerDraft).toHaveBeenCalledWith(expect.stringContaining('run-2'));
    expect(vi.mocked(stageComposerDraft).mock.calls[0]![0]).toContain(AGENT);
    expect(screen.getByTestId('where').textContent).toBe('/chat?agent=vendor.openwop-app.agent-author.agents.agent-author');
  });

  it('starts a run on the normative lane with the registry agent id and the chosen baseline', async () => {
    vi.mocked(listEvalSuites).mockResolvedValue([suite]);
    vi.mocked(listEvalRuns).mockResolvedValue({ items: [
      { runId: 'run-1', status: 'completed', createdAt: '2026-10-01T00:00:00Z', suiteRef: suite.ref, agentId: AGENT, aggregateScore: 1, passed: true, taskCount: 1, passedCount: 1 },
    ] });
    vi.mocked(startEvalRun).mockResolvedValue({ runId: 'run-2' });
    vi.mocked(getEvalProgress).mockResolvedValue(completed);
    renderPanel();

    const baseline = await screen.findByLabelText('Compare with');
    fireEvent.change(baseline, { target: { value: 'run-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Run suite/ }));
    // No model picked ⇒ no `ai` (the agent's own model).
    await waitFor(() => expect(startEvalRun).toHaveBeenCalledWith({ evalSuiteRef: suite.ref, agentId: AGENT, baselineRunId: 'run-1' }));
    expect(await screen.findByRole('table', { name: 'Per-task results' })).toBeTruthy();
  });

  it('places a server 400 inline on the field it names', async () => {
    vi.mocked(putEvalSuite).mockRejectedValue(
      new AgentEvalsRequestError('suiteId: must match ^[a-z0-9.-]+\\.evals\\.[a-z0-9-]+$', 400, 'validation_error', 'suiteId'),
    );
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Create suite/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save suite' }));

    const input = await screen.findByLabelText(/Suite id/);
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    const errorId = (input.getAttribute('aria-describedby') ?? '').split(' ').find((id) => id.endsWith('-error'))!;
    expect(document.getElementById(errorId)?.textContent).toBe('must match ^[a-z0-9.-]+\\.evals\\.[a-z0-9-]+$');
    // A new suite is a CREATE — it must never overwrite an existing ref (EVUX-1).
    expect(putEvalSuite).toHaveBeenCalledWith(expect.objectContaining({ targetAgentId: AGENT, tasks: expect.any(Array) }), { create: true });
  });

  it('pins the picked model as configurable.ai, from the chat model catalog', async () => {
    vi.mocked(listEvalSuites).mockResolvedValue([suite]);
    vi.mocked(fetchModelCapabilities).mockResolvedValue([{ provider: 'anthropic', capabilities: [], models: [
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', capabilities: ['text', 'tools'], recommended: true },
      { id: 'text-only', label: 'Text only', capabilities: ['text'], recommended: false },
    ] }]);
    vi.mocked(startEvalRun).mockResolvedValue({ runId: 'run-3' });
    vi.mocked(getEvalProgress).mockResolvedValue({ ...completed, runId: 'run-3' });
    renderPanel();
    const model = await screen.findByLabelText('Model') as HTMLSelectElement;
    // EVUX-10 — grouped under the provider's display name; a model without tools is not offered.
    expect(model.querySelector('optgroup')?.getAttribute('label')).toBe('Anthropic');
    expect([...model.options].map((o) => o.value)).toEqual(['', 'anthropic:claude-sonnet-5-5']);
    fireEvent.change(model, { target: { value: 'anthropic:claude-sonnet-5-5' } });
    fireEvent.click(screen.getByRole('button', { name: /Run suite/ }));
    await waitFor(() => expect(startEvalRun).toHaveBeenCalledWith({ evalSuiteRef: suite.ref, agentId: AGENT, ai: { provider: 'anthropic', model: 'claude-sonnet-5-5' } }));
  });

  it('records tool calls for this agent and shows a locked-version refusal on the suite picker', async () => {
    const draft: StoredSuite = { ...suite, ref: 'support.evals.refunds@1.0.1', suite: { ...suite.suite, version: '1.0.1' }, locked: false };
    vi.mocked(listEvalSuites).mockResolvedValue([suite, draft]);
    vi.mocked(getCapture).mockResolvedValue({ agentId: AGENT, enabled: false, runs: [{ runId: 'r-live-1', calls: 2, lastAt: '2026-10-13T00:00:00Z' }] });
    vi.mocked(setCapture).mockResolvedValue({ agentId: AGENT, enabled: true });
    vi.mocked(promoteRunToSuite).mockRejectedValue(new AgentEvalsRequestError('locked', 409, 'conflict'));
    renderPanel();

    // EVUX-9 — DECLINING the consent records nothing (round 1 checked only accept).
    vi.mocked(confirm).mockResolvedValueOnce(false);
    fireEvent.click(await screen.findByLabelText(/Record tool calls for evals/));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); });
    expect(setCapture).not.toHaveBeenCalled();
    vi.mocked(confirm).mockClear();

    fireEvent.click(screen.getByLabelText(/Record tool calls for evals/));
    // EVUX-9 — turning recording on is a consent moment.
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Record tool calls for Iris?', confirmLabel: 'Start recording' })));
    expect(String(vi.mocked(confirm).mock.calls[0]![0].body)).toMatch(/anyone in this workspace.*30 days.*keeps its calls in that suite/s);
    await waitFor(() => expect(setCapture).toHaveBeenCalledWith(AGENT, true));
    expect(getCapture).toHaveBeenCalledWith(AGENT);

    fireEvent.click(screen.getByRole('button', { name: 'Add run r-live-1 to a suite' }));
    const form = screen.getByRole('group', { name: 'Add run r-live-1 to a suite' });
    // Only the UNLOCKED version is offered.
    const picker = within(form).getByLabelText('Suite') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(['support.evals.refunds@1.0.1']);
    fireEvent.change(within(form).getByLabelText(/Expected output contains/), { target: { value: '30 days' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(picker.getAttribute('aria-invalid')).toBe('true'));
    expect(promoteRunToSuite).toHaveBeenCalledWith('support.evals.refunds@1.0.1', { fromRunId: 'r-live-1', expectedContains: '30 days' });
    expect(within(form).getByRole('alert').textContent).toMatch(/can’t take new tasks/);
  });
});

describe('AgentEvalsPanel — ADR 0889 residue (focus restore, pack suites)', () => {
  it('returns focus to the Edit button that opened the editor when it is cancelled', async () => {
    vi.mocked(listEvalSuites).mockResolvedValue([{ ...suite, locked: false }]);
    renderPanel();
    const edit = await screen.findByRole('button', { name: `Edit ${suite.ref}` });
    fireEvent.click(edit);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe(`Edit ${suite.ref}`));
  });

  it('returns focus to the run history when the scorecard closes', async () => {
    vi.mocked(listEvalSuites).mockResolvedValue([suite]);
    vi.mocked(listEvalRuns).mockResolvedValue({ items: [
      { runId: 'run-2', status: 'completed', createdAt: '2026-10-02T00:00:00Z', suiteRef: suite.ref, agentId: AGENT, aggregateScore: 0.67, passed: false, taskCount: 1, passedCount: 0 },
    ] });
    vi.mocked(getEvalProgress).mockResolvedValue(completed);
    renderPanel();
    const history = await screen.findByRole('table', { name: 'Eval runs for this agent, newest first' });
    fireEvent.click(within(history).getAllByRole('row')[1]!);
    await screen.findByRole('table', { name: 'Per-task results' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(document.activeElement?.id).toBe('ae-history-title'));
  });

  it('shows a pack-shipped suite read-only: a Pack chip, no Edit or Delete', async () => {
    const packed: StoredSuite = { ref: 'vendor.x.evals.shipped@1.0.0', suite: { ...suite.suite, suiteId: 'vendor.x.evals.shipped' }, locked: true, source: 'pack', pack: 'vendor.x.agents@2.0.0' };
    vi.mocked(listEvalSuites).mockResolvedValue([packed]);
    renderPanel();
    const chip = await screen.findByText('Pack');
    expect(chip.getAttribute('title')).toContain('vendor.x.agents@2.0.0');
    expect(screen.queryByRole('button', { name: `Edit ${packed.ref}` })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete vendor\.x/ })).toBeNull();
  });
});
