/**
 * ADR 0870 §Stopgap — honest Work-Twin portfolio cards.
 *
 * The ten Work-Twin portfolios bind pinned `tmpl.*` workflows whose AI steps are
 * the sample mock-AI node. Under the sign-in deploy posture that node is not
 * registered (LEAK-3), yet "Run now" was enabled for them because `known` came
 * from an id list in this bundle. The host now answers per card; these pin both
 * card states the host can produce:
 *
 *   1. demo + runnable   → a labelled "Demo" chip with its explanation, Run now ENABLED
 *   2. demo + blocked    → the same chip, Run now DISABLED and described by the reason;
 *                          clicking it never reaches the run client
 *
 * plus the degrade path (availability read fails → previous behaviour), and the
 * Assign picker: a demo the host says cannot run here is not OFFERED (one batched read).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { RosterEntry } from '../rosterClient.js';
import type { WorkflowAvailability } from '../../workflows/workflowsClient.js';

type WorkflowsClient = typeof import('../../workflows/workflowsClient.js');
const { createRun, getWorkflowRunInputs, listWorkflowSummaries, getWorkflowAvailability } = vi.hoisted(() => ({
  createRun: vi.fn<typeof import('../../client/runsClient.js')['createRun']>(),
  getWorkflowRunInputs: vi.fn<WorkflowsClient['getWorkflowRunInputs']>(),
  listWorkflowSummaries: vi.fn<WorkflowsClient['listWorkflowSummaries']>(),
  getWorkflowAvailability: vi.fn<WorkflowsClient['getWorkflowAvailability']>(),
}));
vi.mock('../../client/runsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../client/runsClient.js')>()), createRun,
}));
vi.mock('../../workflows/workflowsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../workflows/workflowsClient.js')>()),
  getWorkflowRunInputs, listWorkflowSummaries, getWorkflowAvailability,
}));

const { AgentWorkflowPortfolioPanel } = await import('../AgentWorkflowPortfolioPanel.js');

const WF = 'tmpl.reporting.daily-summary';
const entry: RosterEntry = {
  rosterId: 'host:ezra', persona: 'Ezra', agentRef: { agentId: 'a-ezra' }, workflows: [WF],
  tenantId: 't1', enabled: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const avail = (a: WorkflowAvailability): [string, WorkflowAvailability] => [a.workflowId, a];

/** Wait for the availability read to SETTLE (resolve or reject), not just to be
 *  called: absence of a chip / an enabled button is also what the LOADING state
 *  shows, so asserting it before the read lands proves nothing (wave 43). */
const settled = async (): Promise<void> => {
  await vi.waitFor(() => expect(getWorkflowAvailability).toHaveBeenCalled());
  const pending = getWorkflowAvailability.mock.results[0]!.value as Promise<unknown>;
  await act(async () => { await pending.catch(() => undefined); });
};

const renderPanel = async () => {
  await act(async () => {
    render(
      <MemoryRouter>
        <AgentWorkflowPortfolioPanel entry={entry} onChanged={() => undefined} />
      </MemoryRouter>,
    );
  });
};
const runButton = () => screen.getByRole('button', { name: /run now/i }) as HTMLButtonElement;

beforeEach(() => {
  createRun.mockResolvedValue({ runId: 'run-1', status: 'pending', eventsUrl: '/v1/runs/run-1/events' });
  // Not an owned workflow: `known` must come from the host, not from this list.
  listWorkflowSummaries.mockResolvedValue([]);
  getWorkflowRunInputs.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('Work-Twin demo cards', () => {
  it('demo + runnable: shows the Demo chip and explanation, and Run now launches', async () => {
    getWorkflowAvailability.mockResolvedValue(new Map([avail({ workflowId: WF, known: true, demo: true, runnable: true })]));
    await renderPanel();
    expect(await screen.findByText('Demo')).toBeTruthy();
    expect(screen.getByText(/return canned demo output/i)).toBeTruthy();
    expect(screen.queryByText(/can’t run on this deployment/i)).toBeNull();
    const btn = runButton();
    expect(btn.disabled).toBe(false);
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(createRun).toHaveBeenCalledTimes(1));
    expect(createRun.mock.calls[0]![0]).toMatchObject({ workflowId: WF, inputs: {} });
  });

  it('demo + blocked: Run now is disabled, described by the reason, and never starts a run', async () => {
    getWorkflowAvailability.mockResolvedValue(new Map([avail({
      workflowId: WF, known: true, demo: true, runnable: false, reason: 'demo-node-unavailable',
    })]));
    await renderPanel();
    const reason = await screen.findByText(/can’t run on this deployment/i);
    expect(screen.getByText('Demo')).toBeTruthy();
    const btn = runButton();
    expect(btn.disabled).toBe(true);
    const describedBy = btn.getAttribute('aria-describedby');
    expect(describedBy, 'the disabled control must point at its reason').toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain(reason.textContent?.trim() ?? '');
    await act(async () => { fireEvent.click(btn); });
    expect(createRun).not.toHaveBeenCalled();
    expect(getWorkflowRunInputs).not.toHaveBeenCalled();
  });

  it('a non-demo workflow carries no Demo chip', async () => {
    getWorkflowAvailability.mockResolvedValue(new Map([avail({ workflowId: WF, known: true, demo: false, runnable: true })]));
    await renderPanel();
    await settled();
    expect(getWorkflowAvailability).toHaveBeenCalledWith(expect.arrayContaining([WF]));
    expect(screen.queryByText('Demo')).toBeNull();
    expect(runButton().disabled).toBe(false);
  });

  it('degrades to the previous behaviour when the availability read fails', async () => {
    getWorkflowAvailability.mockRejectedValue(new Error('availability read failed (500)'));
    await renderPanel();
    await settled();
    expect(screen.queryByText('Demo')).toBeNull();
    // `tmpl.reporting.daily-summary` is in the bundled role-template list, so the
    // pre-ADR-0870 `known` still enables it — a transient read error must not
    // disable every card.
    expect(runButton().disabled).toBe(false);
  });
});

describe('Assign-a-workflow picker (ADR 0870)', () => {
  const OTHER = 'tmpl.reporting.weekly-business-review';
  const optionValues = () => Array.from(
    (screen.getByLabelText(/workflow to assign/i) as HTMLSelectElement).options,
  ).map((o) => o.value);

  it('reads availability ONCE for the cards and picker candidates together', async () => {
    getWorkflowAvailability.mockResolvedValue(new Map());
    await renderPanel();
    await waitFor(() => expect(getWorkflowAvailability).toHaveBeenCalled());
    expect(getWorkflowAvailability).toHaveBeenCalledTimes(1);
    const ids = getWorkflowAvailability.mock.calls[0]![0];
    expect(ids).toContain(WF);
    expect(ids).toContain(OTHER);
  });

  it('drops demos this deployment cannot run and says so', async () => {
    getWorkflowAvailability.mockImplementation(async (ids) => new Map(ids.map((id) => avail({
      workflowId: id, known: true, demo: true, runnable: false, reason: 'demo-node-unavailable',
    }))));
    await renderPanel();
    await waitFor(() => expect(optionValues()).not.toContain(OTHER));
    expect(optionValues()).toEqual(['']);
    expect(screen.getByText(/demo workflows are unavailable on this deployment/i)).toBeTruthy();
  });

  it('offers everything (no note) when the availability read fails', async () => {
    getWorkflowAvailability.mockRejectedValue(new Error('availability read failed (500)'));
    await renderPanel();
    await settled();
    expect(optionValues()).toContain(OTHER);
    expect(screen.queryByText(/unavailable on this deployment/i)).toBeNull();
  });

  it('offers runnable demos (cookie posture) with no note', async () => {
    getWorkflowAvailability.mockImplementation(async (ids) => new Map(ids.map((id) => avail({
      workflowId: id, known: true, demo: true, runnable: true,
    }))));
    await renderPanel();
    await settled();
    expect(optionValues()).toContain(OTHER);
    expect(screen.queryByText(/unavailable on this deployment/i)).toBeNull();
  });
});
