/**
 * CHAIN-PROMPT-1 (ADR 0507 follow-up) — the agent portfolio's "Run now" launched
 * a workflow with NO inputs, whatever the workflow declared.
 *
 * That was invisible while seeded definitions carried `variables: []` — nothing to
 * collect, so nothing looked missing. ADR 0507's deferred seeding populates
 * `variables[]` for the chains that need values, so the contract now exists and this
 * surface was the one ignoring it: Run was enabled, the run started, and it died
 * mid-way naming an internal node instead of asking for the value.
 *
 * `features/projects/ProjectWorkflowsTab.tsx` already had the right shape. These
 * assert this panel now matches it — and, just as importantly, that the degrade path
 * survives: a workflow whose contract cannot be READ must still run, because built-in
 * role templates have no stored definition and blocking them would be a regression.
 *
 * Red under: skipping the contract read or the prompt gate (`variables.length > 0`),
 * dropping the collected inputs or the `configurable` key (ADR 0712 — a picked key
 * must ride `configurable.ai.credentialRef`, never `inputs`), or failing closed on an
 * unreadable contract (probes w32g3-agent-*).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { RosterEntry } from '../rosterClient.js';

const { createRun, getWorkflowRunInputs, listWorkflowSummaries, updateRosterEntry, listStoredRefs, getWorkflowAvailability } = vi.hoisted(() => ({
  createRun: vi.fn<typeof import('../../client/runsClient.js').createRun>(),
  getWorkflowRunInputs: vi.fn<typeof import('../../workflows/workflowsClient.js').getWorkflowRunInputs>(),
  listWorkflowSummaries: vi.fn<typeof import('../../workflows/workflowsClient.js').listWorkflowSummaries>(),
  updateRosterEntry: vi.fn<typeof import('../rosterClient.js').updateRosterEntry>(),
  listStoredRefs: vi.fn<typeof import('../../byok/lib/byokClient.js').listStoredRefs>(),
  // ADR 0870 — the panel's availability read; an empty answer keeps the
  // pre-0870 `known` path these tests exercise.
  getWorkflowAvailability: vi.fn<typeof import('../../workflows/workflowsClient.js').getWorkflowAvailability>(async () => new Map()),
}));
vi.mock('../../byok/lib/byokClient.js', async (orig) => ({
  ...(await orig<typeof import('../../byok/lib/byokClient.js')>()), listStoredRefs,
}));
vi.mock('../../client/runsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../client/runsClient.js')>()), createRun,
}));
vi.mock('../../workflows/workflowsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../workflows/workflowsClient.js')>()),
  getWorkflowRunInputs, listWorkflowSummaries, getWorkflowAvailability,
}));
vi.mock('../rosterClient.js', async (orig) => ({
  ...(await orig<typeof import('../rosterClient.js')>()), updateRosterEntry,
}));

const { AgentWorkflowPortfolioPanel } = await import('../AgentWorkflowPortfolioPanel.js');

const entry: RosterEntry = {
  rosterId: 'r1', persona: 'Iris', agentRef: { agentId: 'chief-of-staff' },
  workflows: ['wf.seed.support-kb-answer'], tenantId: 't1', enabled: true, roleKey: 'chief-of-staff',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
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

const clickRun = async () => {
  // By accessible name — `disabled={!known}` would make a click on an inert button a no-op,
  // so assert it is enabled before clicking (otherwise every case below is vacuous).
  const btn = screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement;
  expect(btn.disabled, 'fixture guard: the Run control must be live').toBe(false);
  await act(async () => { fireEvent.click(btn); });
};

beforeEach(() => {
  createRun.mockResolvedValue({ runId: 'run-1', status: 'pending', eventsUrl: '/runs/run-1/events' });
  listStoredRefs.mockResolvedValue([]);
  // The Run control is `disabled={!known}`, and `known` needs the workflow in the
  // summaries list — an empty list leaves the button inert and every assertion below
  // would pass vacuously against a click that did nothing.
  listWorkflowSummaries.mockResolvedValue([{
    workflowId: 'wf.seed.support-kb-answer', kind: 'workflow', name: 'Answer from the knowledge base',
    nodeCount: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }]);
  getWorkflowRunInputs.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Run now collects the declared inputs first', () => {
  it('PROMPTS instead of launching when the workflow declares inputs', async () => {
    getWorkflowRunInputs.mockResolvedValue([
      { name: 'question', type: 'string', required: true, description: 'What to answer' },
    ]);
    await renderPanel();
    await clickRun();
    // The run must NOT have started — that is the whole bug.
    await waitFor(() => expect(screen.getByText(/What to answer/i)).toBeTruthy());
    expect(createRun, 'a workflow that asks for input must not launch without it').not.toHaveBeenCalled();
    // (Absorbs the former "READS the run-input contract" case, which this one covers:
    // probe w32g3-agent-no-read reddened both.) The read names THIS workflow.
    expect(getWorkflowRunInputs).toHaveBeenCalledWith('wf.seed.support-kb-answer');
  });

  it('passes the collected values through to the run', async () => {
    getWorkflowRunInputs.mockResolvedValue([{ name: 'question', type: 'string', required: true }]);
    await renderPanel();
    await clickRun();
    const field = await screen.findByRole('textbox');
    await act(async () => { fireEvent.change(field, { target: { value: 'how do I reset my password' } }); });
    // The dialog submits via a type=submit button that is disabled until every
    // required value is answered — submitting the FORM exercises the same guard.
    const go = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    expect(go, 'the dialog must offer a submit control').toBeTruthy();
    expect(go!.disabled, 'submit must be enabled once the required value is filled').toBe(false);
    await act(async () => { fireEvent.click(go!); });
    await waitFor(() => expect(createRun).toHaveBeenCalled());
    expect(createRun.mock.calls[0]![0].inputs).toEqual({ question: 'how do I reset my password' });
  });

  it('ADR 0712 — a picked stored key reaches the run as configurable.ai.credentialRef, not as an input', async () => {
    listStoredRefs.mockResolvedValue(['byok:google', 'anthropic:prod']);
    getWorkflowRunInputs.mockResolvedValue([
      { name: 'question', type: 'string', required: true },
      { name: 'credentialRef', type: 'string', required: false },
    ]);
    await renderPanel();
    await clickRun();
    // By LABEL: the panel has its own <select> (the add-workflow picker), and a bare
    // `querySelector('select')` found that one first and "picked" nothing.
    const picker = await waitFor(() => {
      const el = screen.getByLabelText('Credential ref');
      expect(el.tagName, 'the credential variable must render as a picker over the stored keys').toBe('SELECT');
      return el as HTMLSelectElement;
    });
    await act(async () => { fireEvent.change(screen.getByRole('textbox'), { target: { value: 'q' } }); });
    await act(async () => { fireEvent.change(picker, { target: { value: 'byok:google' } }); });
    await act(async () => { fireEvent.click(document.querySelector('button[type="submit"]') as HTMLButtonElement); });
    await waitFor(() => expect(createRun).toHaveBeenCalled());
    const req = createRun.mock.calls[0]![0];
    expect(req.inputs).toEqual({ question: 'q' });
    expect(req.configurable).toEqual({ version: 1, ai: { credentialRef: 'byok:google' } });
  });

  it('still launches a workflow that declares NO inputs', async () => {
    await renderPanel();
    await clickRun();
    await waitFor(() => expect(createRun).toHaveBeenCalled());
    expect(createRun.mock.calls[0]![0].inputs).toEqual({});
  });

  it('DEGRADES to a plain run when the contract cannot be read', async () => {
    // Built-in role templates have no stored definition; blocking them on a failed
    // read would trade one silent failure for a louder regression.
    //
    // ADR 0730 C.4 — the message was `get_workflow_404`, which the code no
    // longer produces: `getWorkflowRunInputs` reads through the major-2 client
    // now, so a genuine read failure arrives as a `WopError` and a NOT-FOUND
    // resolves to `[]` rather than rejecting (all three callers collapsed both
    // to a plain run anyway — see their catch blocks). The mock is a rejection
    // because this test covers the REJECTING half, which is still real for a
    // 5xx; only the string was fiction.
    getWorkflowRunInputs.mockRejectedValue(new Error('workflow read failed (500)'));
    await renderPanel();
    await clickRun();
    await waitFor(() => expect(createRun).toHaveBeenCalled());
    // A PLAIN run: no inputs, and no input dialog was opened instead.
    expect(createRun.mock.calls[0]![0].inputs).toEqual({});
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
