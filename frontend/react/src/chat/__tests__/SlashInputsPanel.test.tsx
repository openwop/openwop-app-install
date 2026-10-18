/**
 * ADR 0768 follow-up B2 — the inline `/workflow` inputs + "usually takes" line.
 * Pins: the form shows only for 2+ non-credential inputs; a credential input is
 * never a typed field; the estimate line comes from HISTORY only (a static
 * model-priced floor is never shown); the slug-keyed hand-off is one-shot.
 */
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { RunVariable } from '../../workflows/workflowsClient.js';
import type { FleetStats, WorkflowCostEstimate, WorkflowStatsRow } from '../../workflows/fleetInsightsClient.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k) }) }));
vi.mock('../lib/workflowMentions.js', () => ({
  detectWorkflowSlashMention: (text: string) => (/^\/brief\b/.test(text.trim())
    ? { entry: { slug: 'brief', workflowId: 'wf_brief', displayName: 'Brief', description: '', toolName: 'brief' }, trailing: null, agentSlug: null }
    : null),
}));
const EMPTY_STATS: FleetStats = { rowsConsidered: 0, truncated: false, sinceOldest: null, workflows: [] };
const state = vi.hoisted(() => ({
  inputs: [] as RunVariable[],
  est: null as WorkflowCostEstimate | null,
  stats: null as FleetStats | null,
}));
vi.mock('../../workflows/workflowsClient.js', () => ({ getWorkflowRunInputs: vi.fn(async (_id: string): Promise<RunVariable[]> => state.inputs) }));
vi.mock('../../workflows/fleetInsightsClient.js', () => ({
  fetchWorkflowEstimate: vi.fn(async (_id: string): Promise<WorkflowCostEstimate | null> => state.est),
  fetchFleetStats: vi.fn(async (): Promise<FleetStats> => state.stats ?? EMPTY_STATS),
}));

import { SlashInputsPanel, type SlashInputsState } from '../SlashInputsPanel.js';
import { stageSlashInputs, takeStagedSlashInputs } from '../lib/slashInputs.js';
import { getWorkflowRunInputs } from '../../workflows/workflowsClient.js';
import { fetchFleetStats, fetchWorkflowEstimate } from '../../workflows/fleetInsightsClient.js';

const inputsMock = vi.mocked(getWorkflowRunInputs);
const estMock = vi.mocked(fetchWorkflowEstimate);
const statsMock = vi.mocked(fetchFleetStats);

beforeEach(() => {
  state.inputs = []; state.est = null; state.stats = null;
  inputsMock.mockClear(); estMock.mockClear(); statsMock.mockClear();
});
afterEach(() => cleanup());

/** Settle signal: every read the panel started has resolved and its `.then` has run. */
async function settleReads(): Promise<void> {
  await act(async () => {
    await Promise.allSettled([...inputsMock.mock.results, ...estMock.mock.results, ...statsMock.mock.results].map((r) => r.value));
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

const statsRow = (workflowId: string, p50Ms: number): WorkflowStatsRow => ({
  workflowId, runs: 12, completed: 12, failed: 0, cancelled: 0, active: 0, successRate: 1,
  p50Ms, p95Ms: p50Ms, costUsdTotal: 0, costUsdMedian: null, costDaily: [], topFailures: [], nodeFailures: [], lastRunAt: null,
});

const two: RunVariable[] = [
  { name: 'topic', type: 'string', required: true },
  { name: 'audience', type: 'string', required: false },
  { name: 'credentialRef', type: 'string', required: false },
];

describe('SlashInputsPanel (ADR 0768 B2)', () => {
  it('renders the shared form for 2+ inputs, never the credential, and reports typed values', async () => {
    state.inputs = two;
    const onChange = vi.fn<(s: SlashInputsState | null) => void>();
    render(<SlashInputsPanel text="/brief " onChange={onChange} />);
    const topic = await screen.findByLabelText(/Topic/);
    expect(screen.getByLabelText(/Audience/)).toBeTruthy();
    expect(screen.queryByLabelText(/Credential/i)).toBeNull();
    fireEvent.change(topic, { target: { value: 'tides' } });
    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)?.[0];
      expect(last?.slug).toBe('brief');
      expect(last?.values['topic']).toBe('tides');
      expect(last?.variables.map((v) => v.name)).toEqual(['topic', 'audience']);
    });
  });

  it('shows nothing for a one-input workflow with no history (trailing text still carries it)', async () => {
    state.inputs = [{ name: 'topic', type: 'string', required: true }, { name: 'credentialRef', required: false }];
    const onChange = vi.fn<(s: SlashInputsState | null) => void>();
    const { container } = render(<SlashInputsPanel text="/brief " onChange={onChange} />);
    // Not the mount-time null: wait for the inputs read to land.
    await waitFor(() => expect(inputsMock).toHaveBeenCalledWith('wf_brief'));
    await settleReads();
    expect(container.innerHTML).toBe('');
    expect(onChange.mock.calls.at(-1)?.[0]).toBeNull();
  });

  it('the usual line comes from history only — a static floor is never shown', async () => {
    state.inputs = [{ name: 'topic', required: true }];
    state.est = {
      static: {
        floorUsd: 0.02, aiNodes: 1,
        assumptions: { tokensPerNode: { input: 1000, output: 500 }, model: 'm', ratePer1k: { input: 0.01, output: 0.02 } },
      },
    };
    const { container, unmount } = render(<SlashInputsPanel text="/brief" onChange={vi.fn()} />);
    await waitFor(() => expect(statsMock).toHaveBeenCalled());
    await settleReads();
    expect(container.innerHTML).toBe('');
    unmount();

    // History: the median (not the p95) and THIS workflow's p50 (not a decoy row's).
    state.est = { historical: { medianUsd: 0.04, p95Usd: 0.09, samples: 12 } };
    state.stats = { rowsConsidered: 24, truncated: false, sinceOldest: null, workflows: [statsRow('wf_other', 7_000), statsRow('wf_brief', 42_000)] };
    render(<SlashInputsPanel text="/brief" onChange={vi.fn()} />);
    const line = await screen.findByText(/slashUsualDuration/);
    const text = line.textContent ?? '';
    expect(text).toContain('slashUsualCost');
    expect(text).toContain('"count":12');
    expect(text).toMatch(/"cost":"[^"]*0\.04/);
    expect(text).not.toContain('0.09');
    expect(text).toMatch(/"duration":"[^"]*42/);
    expect(text).not.toMatch(/"duration":"[^"]*7/);
  });

  it('is absent, and reads nothing, when the text is not a workflow command', async () => {
    const { container } = render(<SlashInputsPanel text="hello" onChange={vi.fn()} />);
    await settleReads();
    expect(container.innerHTML).toBe('');
    expect(inputsMock).not.toHaveBeenCalled();
    expect(estMock).not.toHaveBeenCalled();
    expect(statsMock).not.toHaveBeenCalled();
  });
});

describe('slashInputs hand-off', () => {
  it('is keyed by slug and one-shot', () => {
    stageSlashInputs('a', { x: 1 });
    expect(takeStagedSlashInputs('b')).toBeNull();
    expect(takeStagedSlashInputs('a')).toBeNull(); // a mismatched take still clears it
    stageSlashInputs('a', { x: 1 });
    expect(takeStagedSlashInputs('a')).toEqual({ x: 1 });
    expect(takeStagedSlashInputs('a')).toBeNull();
  });
});
