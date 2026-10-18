/**
 * ADR 0889 grade remediation (stream B) — the Evals tab's UX findings, each
 * asserted where the user meets it. The client is mocked (the real
 * `AgentEvalsRequestError` is kept, since the components branch on it):
 *   - M14: a locked tenant version shows no Delete; an unlocked one does;
 *   - EVUX-1: a create never overwrites — a `suite_exists` 409 offers "Save as
 *     version N" (sent with `create:true`), and "New suite" proposes a free id;
 *   - EVUX-2/3/6: focus moves into the promote form, onto an opened scorecard,
 *     and onto the first invalid control after a refusal;
 *   - EVUX-5: unsaved edits are reported to the tab host and Cancel asks;
 *   - AE-4/BE-1/BE-3: refusals and run errors read as localized sentences;
 *   - EVUX-12/13/19: terminal statuses, a closable scorecard error, the read-only reason;
 *   - EVUX-21: axe finds no violations in the panel, the scorecard or the editor.
 *
 * Sabotage-witnessed (each red on its own): Delete shown on locked (M14); the
 * create flag forced to `!initial` (EVUX-1); the scorecard / invalid-control
 * `focus()` removed (EVUX-3/6); the promote `reason` branch skipped (AE-4); an
 * unlabeled input injected into the panel and into the editor (axe); the
 * `onDirtyChange` effect removed (EVUX-5).
 *
 * CORRECTED (w52): this header used to also list "the capture confirm skipped
 * (EVUX-9)" as witnessed HERE. No case in this file asserts that confirm — the
 * EVUX-9 consent witness is `AgentEvalsPanel.test.tsx` ('records tool calls for
 * this agent…', accept AND decline legs). The EVUX-19/EVUX-9 case below only
 * asserts the read-only reason a reader sees.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import axe from 'axe-core';

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

import {
  AgentEvalsRequestError, getCapture, getEvalCapability, getEvalProgress, listEvalRuns, listEvalSuites, promoteRunToSuite, putEvalSuite, startEvalRun,
  type EvalProgress, type StoredSuite,
} from '../agent/agentEvalsClient.js';
import { AgentEvalsPanel } from '../agent/AgentEvalsPanel.js';
import { fetchModelCapabilities } from '../../../client/chatSessionsClient.js';
import { confirm } from '../../../ui/confirm.js';

const AGENT = 'vendor.openwop-app.support';

const base: StoredSuite = {
  ref: 'support.evals.refunds@1.0.0',
  suite: { suiteId: 'support.evals.refunds', version: '1.0.0', modes: ['golden'], tasks: [{ taskId: 'refund-policy', input: 'q', expected: { kind: 'golden', match: { strategy: 'contains', value: '30 days' } } }] },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  locked: false,
};
const locked: StoredSuite = { ...base, ref: 'support.evals.locked@1.0.0', suite: { ...base.suite, suiteId: 'support.evals.locked' }, locked: true };

const finished: EvalProgress = {
  runId: 'run-2', status: 'completed', suiteRef: base.ref, agentId: AGENT,
  progress: { 'refund-policy': { 0: { score: 1, passed: true, scoreLabel: 'pass', evaluatorType: 'golden', costUsd: 0.01, latencyMs: 900, efficiency: { toolCallCount: 1, modelCallCount: 1, inputTokens: 1, outputTokens: 1 }, fixtureMissCount: 0 } } },
  summary: { suiteId: 'support.evals.refunds', suiteVersion: '1.0.0', aggregateScore: 1, passed: true, taskCount: 1, passedCount: 1, tasks: [{ taskId: 'refund-policy', score: 1, passed: true }] },
  error: null,
};

function Where(): JSX.Element { const l = useLocation(); return <output data-testid="where">{l.search}</output>; }
const renderPanel = (opts: { canWrite?: boolean; onDirtyChange?: (d: boolean) => void; at?: string } = {}) => render(
  <MemoryRouter initialEntries={[opts.at ?? '/agents/a?tab=evals']}>
    <Routes>
      <Route path="*" element={<main><AgentEvalsPanel agentId={AGENT} persona="Iris" canWrite={opts.canWrite ?? true} {...(opts.onDirtyChange ? { onDirtyChange: opts.onDirtyChange } : {})} /><Where /></main>} />
    </Routes>
  </MemoryRouter>,
);

/** axe-core in jsdom: layout-dependent rules (contrast) cannot be judged here. */
async function axeViolations(node: Element): Promise<string[]> {
  const res = await axe.run(node, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

beforeEach(() => {
  vi.mocked(getEvalCapability).mockResolvedValue({ modes: ['golden', 'rubric', 'regression'], maxTasksPerSuite: 100, maxCostUsdPerSuite: 5, trajectory: true, trials: { maxTrials: 10 }, fixtureMatching: true, regressionVerdict: true });
  vi.mocked(listEvalSuites).mockResolvedValue([base]);
  vi.mocked(listEvalRuns).mockResolvedValue({ items: [] });
  vi.mocked(getCapture).mockResolvedValue({ agentId: AGENT, enabled: true, runs: [{ runId: 'r-live-1', calls: 2, lastAt: '2026-10-13T00:00:00Z' }] });
  vi.mocked(fetchModelCapabilities).mockResolvedValue([]);
  vi.mocked(confirm).mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Evals tab — M14 locked versions', () => {
  it('hides Delete on a locked tenant version and shows it on an unlocked one', async () => {
    vi.mocked(listEvalSuites).mockResolvedValue([base, locked]);
    renderPanel();
    expect(await screen.findByRole('button', { name: `Delete ${base.ref}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Edit ${locked.ref}` })).toBeTruthy();
    expect(screen.queryByRole('button', { name: `Delete ${locked.ref}` })).toBeNull();
  });
});

describe('Evals tab — EVUX-1 a create never overwrites', () => {
  it('proposes a suite id no listed suite uses', async () => {
    vi.mocked(listEvalSuites).mockResolvedValue([{ ...base, ref: 'vendor.openwop-app.support.evals.default@1.0.0', suite: { ...base.suite, suiteId: 'vendor.openwop-app.support.evals.default' } }]);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /New suite/ }));
    expect((screen.getByLabelText(/Suite id/) as HTMLInputElement).value).toBe('vendor.openwop-app.support.evals.default-2');
  });

  it('recovers a suite_exists 409 by saving as the next free version, with create:true', async () => {
    vi.mocked(putEvalSuite)
      .mockRejectedValueOnce(new AgentEvalsRequestError('exists', 409, 'suite_exists'))
      .mockImplementationOnce(async (s) => ({ ...base, ref: `${s.suiteId}@${s.version}`, suite: s }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /New suite/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save suite' }));

    const version = await screen.findByLabelText(/^Version/);
    await waitFor(() => expect(version.getAttribute('aria-invalid')).toBe('true'));
    // EVUX-6 — focus lands on the control that must change.
    expect(document.activeElement).toBe(version);
    expect(putEvalSuite).toHaveBeenLastCalledWith(expect.objectContaining({ version: '1.0.0' }), { create: true });

    fireEvent.click(screen.getByRole('button', { name: 'Save as version 1.0.1' }));
    await waitFor(() => expect(putEvalSuite).toHaveBeenLastCalledWith(expect.objectContaining({ version: '1.0.1' }), { create: true }));
    expect(await screen.findByText(/Saved vendor\.openwop-app\.support\.evals\.default@1\.0\.1/)).toBeTruthy();
  });

  it('an edit that keeps its ref upserts; changing the version makes it a create', async () => {
    vi.mocked(putEvalSuite).mockImplementation(async (s) => ({ ...base, ref: `${s.suiteId}@${s.version}`, suite: s }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: `Edit ${base.ref}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Save suite' }));
    await waitFor(() => expect(putEvalSuite).toHaveBeenLastCalledWith(expect.objectContaining({ version: '1.0.0' }), { create: false }));

    fireEvent.click(await screen.findByRole('button', { name: `Edit ${base.ref}` }));
    fireEvent.change(screen.getByLabelText(/^Version/), { target: { value: '2.0.0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save suite' }));
    await waitFor(() => expect(putEvalSuite).toHaveBeenLastCalledWith(expect.objectContaining({ version: '2.0.0' }), { create: true }));
  });
});

describe('Evals tab — EVUX-5 unsaved edits', () => {
  it('reports dirty to the tab host, and Cancel asks before discarding', async () => {
    const onDirtyChange = vi.fn();
    renderPanel({ onDirtyChange });
    fireEvent.click(await screen.findByRole('button', { name: `Edit ${base.ref}` }));
    fireEvent.change(screen.getByLabelText(/^Version/), { target: { value: '1.1.0' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    vi.mocked(confirm).mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText(/^Version/)).toBeTruthy(); // stayed

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: `Edit ${base.ref}` });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('a clean editor closes without asking', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: `Edit ${base.ref}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: `Edit ${base.ref}` });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('Evals tab — focus and the URL', () => {
  it('EVUX-3: a history row opens its scorecard in the URL and moves focus to it', async () => {
    vi.mocked(listEvalRuns).mockResolvedValue({ items: [{ runId: 'run-2', status: 'completed', createdAt: '2026-10-02T00:00:00Z', suiteRef: base.ref, agentId: AGENT, aggregateScore: 1, passed: true, taskCount: 1, passedCount: 1 }] });
    vi.mocked(getEvalProgress).mockResolvedValue(finished);
    renderPanel();
    const history = await screen.findByRole('table', { name: 'Eval runs for this agent, newest first' });
    fireEvent.click(within(history).getAllByRole('row')[1]!);
    await waitFor(() => expect(document.activeElement?.id).toBe('ae-scorecard-run-2'));
    expect(screen.getByTestId('where').textContent).toBe('?tab=evals&run=run-2');
  });

  it('EVUX-3: a ?run= link opens that scorecard on load', async () => {
    vi.mocked(getEvalProgress).mockResolvedValue(finished);
    renderPanel({ at: '/agents/a?tab=evals&run=run-2' });
    expect(await screen.findByRole('table', { name: 'Per-task results' })).toBeTruthy();
    expect(getEvalProgress).toHaveBeenCalledWith('run-2');
  });

  it('EVUX-2: opening the promote form moves focus into it', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Add run r-live-1 to a suite' }));
    const form = screen.getByRole('group', { name: 'Add run r-live-1 to a suite' });
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText('Suite')));
  });

  it('EVUX-6: a 400 on a task field focuses that control', async () => {
    vi.mocked(putEvalSuite).mockRejectedValue(new AgentEvalsRequestError('tasks[0].taskId: must match ^[a-z0-9][a-z0-9-]*$', 400, 'validation_error', 'tasks[0].taskId', { rule: 'pattern' }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: `Edit ${base.ref}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Save suite' }));
    const taskId = await screen.findByLabelText(/^Task id/);
    await waitFor(() => expect(document.activeElement).toBe(taskId));
    // AE-2 — the pattern reads as the field's own format help, not a regex.
    const errorId = (taskId.getAttribute('aria-describedby') ?? '').split(' ').find((id) => id.endsWith('-error'))!;
    expect(document.getElementById(errorId)?.textContent).toBe('Lowercase letters, digits and hyphens.');
  });
});

describe('Evals tab — localized refusals', () => {
  it('AE-4: an agent-mismatch promote says so (not "nothing captured")', async () => {
    vi.mocked(promoteRunToSuite).mockRejectedValue(new AgentEvalsRequestError('English prose', 400, 'validation_error', 'fromRunId', { reason: 'agent_mismatch' }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Add run r-live-1 to a suite' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(await screen.findByText(/Another agent made this run’s tool calls/)).toBeTruthy();
    expect(screen.queryByText(/English prose/)).toBeNull();
  });

  it('BE-3: a plan refusal on Run names the plan, not a generic "forbidden"', async () => {
    vi.mocked(startEvalRun).mockRejectedValue(new AgentEvalsRequestError('Agent evals are not included…', 403, 'forbidden', undefined, { reason: 'not_entitled' }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Run suite/ }));
    expect(await screen.findByText('Agent evals aren’t included in this workspace’s plan.')).toBeTruthy();
  });

  it('BE-1: a failed run reads as a localized sentence, the raw code behind a disclosure', async () => {
    vi.mocked(getEvalProgress).mockResolvedValue({ ...finished, status: 'failed', summary: null, error: { code: 'eval_cost_ceiling_exceeded', message: 'Eval exceeded the $5 cost ceiling.' } });
    renderPanel({ at: '/agents/a?tab=evals&run=run-2' });
    expect(await screen.findByText(/reached the cost limit for one suite run/)).toBeTruthy();
    const details = screen.getByText('Technical details').closest('details')!;
    expect(details.open).toBe(false);
    expect(within(details).getByText('eval_cost_ceiling_exceeded')).toBeTruthy();
    // Eval honesty: a failed run is never shown as Passed.
    expect(screen.queryByText('Passed')).toBeNull();
  });
});

describe('Evals tab — A2 contract surfaces', () => {
  it('an agent-mismatch promote can be added anyway, with overrideTargetAgent', async () => {
    vi.mocked(promoteRunToSuite)
      .mockRejectedValueOnce(new AgentEvalsRequestError('x', 400, 'validation_error', 'fromRunId', { reason: 'agent_mismatch', params: { agentId: 'other', targetAgentId: AGENT } }))
      .mockResolvedValueOnce({ ...base, suite: { ...base.suite, tasks: [...base.suite.tasks, { taskId: 'from-run-1', input: 'q', expected: { kind: 'trajectory', trajectory: { match: 'in-order', calls: [] } } }] } });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Add run r-live-1 to a suite' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add it anyway' }));
    await waitFor(() => expect(promoteRunToSuite).toHaveBeenLastCalledWith(base.ref, { fromRunId: 'r-live-1', overrideTargetAgent: true }));
    // EVUX-8 — the notice names the new task and opens the suite to edit it.
    expect(await screen.findByText(/Added task from-run-1 to/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit suite' })).toBeTruthy();
  });

  it('EVUX-7: a captured run shows its lane and first call, and links its viewer', async () => {
    vi.mocked(getCapture).mockResolvedValue({ agentId: AGENT, enabled: true, runs: [
      { runId: 'r-live-1', calls: 2, lastAt: '2026-10-13T00:00:00Z', lane: 'chat', inputPreview: 'crm.lookup: {"id":"A1"}' },
      { runId: 'r-old', calls: 1, lastAt: '2026-10-12T00:00:00Z' },
    ] });
    renderPanel();
    expect(await screen.findByText('From chat')).toBeTruthy();
    expect(screen.getByText('crm.lookup: {"id":"A1"}').getAttribute('dir')).toBe('ltr');
    expect(screen.getByRole('link', { name: 'Open run r-live-1' }).getAttribute('href')).toBe('/runs/r-live-1');
    expect(screen.queryByText('From a run')).toBeNull(); // a pre-EVUX-7 row has no lane: no guess
  });

  it('an errored-call promote offers no override', async () => {
    vi.mocked(promoteRunToSuite).mockRejectedValue(new AgentEvalsRequestError('x', 400, 'validation_error', 'fromRunId', { reason: 'errored_call' }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Add run r-live-1 to a suite' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(await screen.findByText(/can’t be replayed as a test yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add it anyway' })).toBeNull();
  });

  it('a baseline refusal lands on the baseline picker', async () => {
    vi.mocked(listEvalRuns).mockResolvedValue({ items: [{ runId: 'run-1', status: 'completed', createdAt: '2026-10-01T00:00:00Z', suiteRef: base.ref, agentId: AGENT, aggregateScore: 1, passed: true, taskCount: 1, passedCount: 1 }] });
    vi.mocked(startEvalRun).mockRejectedValue(new AgentEvalsRequestError('x', 400, 'validation_error', 'configurable.baselineRunId', { reason: 'baseline_not_completed' }));
    renderPanel();
    const baseline = await screen.findByLabelText('Compare with');
    fireEvent.change(baseline, { target: { value: 'run-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Run suite/ }));
    await waitFor(() => expect(baseline.getAttribute('aria-invalid')).toBe('true'));
  });

  it('says why a verdict is inconclusive, from the progress route; absent or null says nothing extra', async () => {
    const regression = { baselineRunId: 'run-0', scoreDelta: 0, verdict: 'inconclusive' as const, pairedTaskCount: 0 };
    vi.mocked(getEvalProgress).mockResolvedValue({ ...finished, summary: { ...finished.summary!, regression }, regressionReason: 'judge_mismatch' });
    renderPanel({ at: '/agents/a?tab=evals&run=run-2' });
    expect(await screen.findByText('Inconclusive: the two runs were scored by different judge models.')).toBeTruthy();
    cleanup();
    vi.mocked(getEvalProgress).mockResolvedValue({ ...finished, summary: { ...finished.summary!, regression }, regressionReason: null });
    renderPanel({ at: '/agents/a?tab=evals&run=run-2' });
    await screen.findByRole('table', { name: 'Per-task results' });
    expect(screen.queryByText(/^Inconclusive:/)).toBeNull();
  });

  it('marks a redacted suite and pages older history', async () => {
    vi.mocked(listEvalSuites).mockResolvedValue([{ ...base, erasedAt: '2026-10-10T00:00:00Z' }]);
    const row = { runId: 'run-3', status: 'completed', createdAt: '2026-10-03T00:00:00Z', suiteRef: base.ref, agentId: AGENT, aggregateScore: 1, passed: true, taskCount: 1, passedCount: 1 };
    vi.mocked(listEvalRuns)
      .mockResolvedValueOnce({ items: [row], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [{ ...row, runId: 'run-old' }] });
    renderPanel();
    expect((await screen.findByText('Redacted')).closest('.chip')?.getAttribute('title')).toMatch(/data-erasure request/);
    fireEvent.click(screen.getByRole('button', { name: 'Show older runs' }));
    await waitFor(() => expect(listEvalRuns).toHaveBeenLastCalledWith(AGENT, 'c1'));
    const history = screen.getByRole('table', { name: 'Eval runs for this agent, newest first' });
    await waitFor(() => expect(within(history).getAllByRole('row').length).toBe(3));
    expect(screen.queryByRole('button', { name: 'Show older runs' })).toBeNull();
  });
});

describe('Evals tab — statuses and read-only', () => {
  it('EVUX-12: cancelled and expired history rows read as terminal, not "Scoring"', async () => {
    vi.mocked(listEvalRuns).mockResolvedValue({ items: [
      { runId: 'a', status: 'canceled', createdAt: '2026-10-02T00:00:00Z', suiteRef: base.ref, agentId: AGENT },
      { runId: 'b', status: 'expired', createdAt: '2026-10-01T00:00:00Z', suiteRef: base.ref, agentId: AGENT },
    ] });
    renderPanel();
    const history = await screen.findByRole('table', { name: 'Eval runs for this agent, newest first' });
    expect(within(history).getByText('Cancelled')).toBeTruthy();
    expect(within(history).getByText('Expired')).toBeTruthy();
    expect(within(history).queryByText('Scoring')).toBeNull();
  });

  it('EVUX-13: a scorecard that failed to load can be closed', async () => {
    vi.mocked(getEvalProgress).mockRejectedValue(new AgentEvalsRequestError('', 500));
    renderPanel({ at: '/agents/a?tab=evals&run=run-9' });
    await screen.findByText('Couldn’t load this run’s scores');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?tab=evals'));
  });

  it('EVUX-19/EVUX-9: a reader is told why there is no Run and why capture is fixed', async () => {
    renderPanel({ canWrite: false });
    await screen.findByRole('heading', { name: 'Run a suite' });
    expect(screen.queryByRole('button', { name: /Run suite/ })).toBeNull();
    expect(screen.getAllByText('Only people who can edit this agent can change this.').length).toBe(2);
  });
});

describe('Evals tab — EVUX-21 axe', () => {
  it('the panel with a scorecard open has no axe violations', async () => {
    vi.mocked(listEvalSuites).mockResolvedValue([base, locked]);
    vi.mocked(listEvalRuns).mockResolvedValue({ items: [{ runId: 'run-2', status: 'completed', createdAt: '2026-10-02T00:00:00Z', suiteRef: base.ref, agentId: AGENT, aggregateScore: 1, passed: true, taskCount: 1, passedCount: 1 }] });
    vi.mocked(getEvalProgress).mockResolvedValue(finished);
    const { container } = renderPanel({ at: '/agents/a?tab=evals&run=run-2' });
    await screen.findByRole('table', { name: 'Per-task results' });
    expect(await axeViolations(container)).toEqual([]);
  });

  it('the suite editor (form and JSON views) has no axe violations', async () => {
    const { container } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: `Edit ${base.ref}` }));
    await screen.findByLabelText(/^Version/);
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /JSON/ }));
    await screen.findByLabelText(/Suite JSON/);
    expect(await axeViolations(container)).toEqual([]);
  });
});
