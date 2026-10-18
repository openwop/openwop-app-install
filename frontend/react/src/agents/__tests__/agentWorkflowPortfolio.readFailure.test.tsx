/**
 * EMPTY-ON-FAIL near-miss (ADR 0779 D7, the RTP-EMPTY-1 class) — when the reads that
 * decide a portfolio card's state FAIL, the card does not claim the workflow is
 * "Local-only" and does not disable Run now.
 *
 * `listWorkflowSummaries` failing set the caller's workflows to [], and a failed
 * availability read leaves it `null`; together a real backend workflow fell to
 * `isKnownWorkflow` and rendered "Local-only — register on the host…" with Run now
 * disabled: a false claim from reads that never came back. The card now says it
 * could not check, and Run now stays available (the server decides).
 *
 * Break it by removing `setMineFailed(true)` from the workflows catch in
 * AgentWorkflowPortfolioPanel (or by dropping the `unverified ?` branch) → case 1
 * red; drop `!avail &&` from `unverified` (one failed read treated as both) → case 2
 * red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { RosterEntry } from '../rosterClient.js';
import type { WorkflowAvailability } from '../../workflows/workflowsClient.js';

type WfClient = typeof import('../../workflows/workflowsClient.js');
const wf = vi.hoisted(() => ({
  listWorkflowSummaries: vi.fn<WfClient['listWorkflowSummaries']>(),
  getWorkflowAvailability: vi.fn<WfClient['getWorkflowAvailability']>(),
}));
vi.mock('../../workflows/workflowsClient.js', async (orig) => ({
  ...(await orig<WfClient>()),
  listWorkflowSummaries: wf.listWorkflowSummaries,
  getWorkflowAvailability: wf.getWorkflowAvailability,
}));

const { AgentWorkflowPortfolioPanel } = await import('../AgentWorkflowPortfolioPanel.js');

/** A backend workflow id, NOT a built-in role template — so `isKnownWorkflow` is false. */
const WF = 'wf.quarterly-board-pack';
const ENTRY: RosterEntry = {
  rosterId: 'host:ezra', persona: 'Ezra', agentRef: { agentId: 'agent.ezra' },
  workflows: [WF], tenantId: 't1', enabled: true,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
};

const UNKNOWN = 'Couldn’t check whether this workflow is registered on the host. Run now will try anyway.';
const LOCAL_ONLY = 'Local-only — register on the host before it can run from a board or schedule.';

async function renderSettled(): Promise<void> {
  await act(async () => {
    render(<MemoryRouter><AgentWorkflowPortfolioPanel entry={ENTRY} onChanged={() => undefined} /></MemoryRouter>);
  });
  // Settle BOTH reads before asserting anything is absent.
  await act(async () => {
    await wf.listWorkflowSummaries.mock.results[0]?.value.catch(() => undefined);
    await wf.getWorkflowAvailability.mock.results[0]?.value.catch(() => undefined);
  });
}

const runNow = (): HTMLButtonElement => {
  const b = screen.getByRole('button', { name: 'Run now' });
  if (!(b instanceof HTMLButtonElement)) throw new Error('Run now is not a <button>');
  return b;
};

beforeEach(() => { wf.listWorkflowSummaries.mockReset(); wf.getWorkflowAvailability.mockReset(); });
afterEach(cleanup);

describe('a failed read never labels a workflow "Local-only"', () => {
  it('both reads rejected: says it could not check, NOT "Local-only", and Run now stays enabled', async () => {
    wf.listWorkflowSummaries.mockRejectedValue(new Error('wf_500'));
    wf.getWorkflowAvailability.mockRejectedValue(new Error('avail_500'));
    await renderSettled();
    expect(await screen.findByText(UNKNOWN)).toBeTruthy();
    expect(screen.queryByText(LOCAL_ONLY)).toBeNull();
    expect(runNow().disabled).toBe(false);
  });

  it('a failed workflows read does not override the host\'s own availability answer: still "Local-only"', async () => {
    // Only BOTH reads failing is "could not check". When the availability read came
    // back and says the host does not know the workflow, the host is authoritative.
    wf.listWorkflowSummaries.mockRejectedValue(new Error('wf_500'));
    const avail: WorkflowAvailability = { workflowId: WF, known: false, demo: false, runnable: false };
    wf.getWorkflowAvailability.mockResolvedValue(new Map([[WF, avail]]));
    await renderSettled();
    expect(await screen.findByText(LOCAL_ONLY)).toBeTruthy();
    expect(screen.queryByText(UNKNOWN)).toBeNull();
    expect(runNow().disabled).toBe(true);
  });

  it('successful reads that do not know the workflow still say "Local-only" (positive control)', async () => {
    wf.listWorkflowSummaries.mockResolvedValue([]);
    wf.getWorkflowAvailability.mockResolvedValue(new Map());
    await renderSettled();
    expect(await screen.findByText(LOCAL_ONLY)).toBeTruthy();
    expect(screen.queryByText(UNKNOWN)).toBeNull();
    expect(runNow().disabled).toBe(true);
  });
});
