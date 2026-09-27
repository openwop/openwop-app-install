import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { SubjectSchedulesPanel, type SubjectSchedulesClient, type SubjectScheduleRow } from '../SubjectSchedulesPanel.js';

/**
 * The panel is shared by three subjects (projects, profiles, agents) and had NO test
 * at all, so both defects below shipped three times over.
 *
 *  1. `jobs` initialised to `[]` — indistinguishable from a successful empty read — so
 *     "No schedules yet" + its instruction rendered on the FIRST paint, before the list
 *     had even been requested.
 *  2. A failed read left `jobs` at `[]` too, so the same instruction rendered beside the
 *     error Notice: the page told the user nothing was scheduled when it had failed to
 *     find out.
 *
 * Assertions anchor on `copy.emptyBody`, a sentinel supplied by this test, so they turn
 * on the instruction actually being on screen — never on translated copy.
 */

const EMPTY_SENTINEL = 'NOTHING-SCHEDULED-INSTRUCTION';

function mkClient(list: () => Promise<never[]>): SubjectSchedulesClient {
  return {
    list: list as SubjectSchedulesClient['list'],
    create: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
}

function renderPanel(client: SubjectSchedulesClient): void {
  render(
    <SubjectSchedulesPanel
      client={client}
      workflows={['wf-1']}
      copy={{ emptyBody: EMPTY_SENTINEL, helper: 'helper', noWorkflowsHint: 'no-workflows' }}
    />,
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('SubjectSchedulesPanel — read states are distinguishable', () => {
  it('does NOT claim "nothing scheduled" while the read is still in flight', () => {
    // Never resolves: the panel is permanently in its loading state.
    renderPanel(mkClient(() => new Promise<never[]>(() => {})));
    // Synchronous assertion on the FIRST paint — the exact moment the old `[]` init
    // rendered the instruction. A waitFor here would let the assertion pass for the
    // wrong reason.
    expect(screen.queryByText(EMPTY_SENTINEL)).toBeNull();
  });

  it('does NOT claim "nothing scheduled" when the read FAILED', async () => {
    renderPanel(mkClient(() => Promise.reject(new Error('boom'))));
    // Wait for the failure to be RENDERED (the error Notice), then assert the
    // instruction is absent. Waiting on the presence first is what makes the absence
    // check meaningful rather than a race we happen to win.
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    expect(screen.queryByText(EMPTY_SENTINEL)).toBeNull();
  });

  it('DOES show the instruction when the read succeeded and returned nothing', async () => {
    renderPanel(mkClient(() => Promise.resolve([])));
    // The positive case — without it the two absence assertions above would also pass
    // against a panel that never renders the instruction at all.
    await waitFor(() => expect(screen.getByText(EMPTY_SENTINEL)).toBeTruthy());
  });
});

/**
 * GEN-PRJ-1 / WF-PRJ-2 — the daemon records a fire that produced no run
 * (`lastSkippedAt`/`lastSkipReason`); the shared row type used to have no slot
 * for it, so a typo'd schedule read as healthy forever on ALL THREE consumers.
 */
describe('SubjectSchedulesPanel — a dead schedule is visible (GEN-PRJ-1)', () => {
  const row = (extra: Partial<SubjectScheduleRow>): SubjectScheduleRow => ({
    jobId: 'j1', cronExpr: '0 9 * * *', enabled: true, workflowId: 'wf-1', nextFireAt: Date.now() + 3_600_000, ...extra,
  });
  function renderRows(rows: SubjectScheduleRow[]): void {
    render(
      <MemoryRouter>
        <SubjectSchedulesPanel
          client={{ list: async () => rows, create: vi.fn(async () => undefined), update: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) }}
          workflows={['wf-1']}
          copy={{ emptyBody: EMPTY_SENTINEL, helper: 'helper', noWorkflowsHint: 'no-workflows' }}
        />
      </MemoryRouter>,
    );
  }

  it('renders the skip line — when it happened AND why (workflow-unresolved)', async () => {
    renderRows([row({ lastSkippedAt: new Date().toISOString(), lastSkipReason: 'workflow-unresolved' })]);
    // The assistant lane's copy, reused: "Did not run {when} — {reason}".
    await waitFor(() => expect(screen.getByText(/did not run/i)).toBeTruthy());
    expect(screen.getByText(/the workflow could not be resolved/i)).toBeTruthy();
  });

  it('an UNRECOGNIZED wire reason neither fabricates a diagnosis, goes silent, nor asserts absence (F6)', async () => {
    renderRows([row({ lastSkippedAt: new Date().toISOString(), lastSkipReason: 'some-new-reason' })]);
    await waitFor(() => expect(screen.getByText(/did not run/i)).toBeTruthy());
    // A reason WAS recorded — "no reason was recorded" would be a false absence claim.
    expect(screen.getByText(/does not recognize it/i)).toBeTruthy();
    expect(screen.queryByText(/no reason was recorded/i)).toBeNull();
    expect(screen.queryByText(/the run could not be started/i)).toBeNull(); // no invented diagnosis
  });

  it('an ABSENT reason states exactly that — "no reason was recorded" (F6 counterpart)', async () => {
    renderRows([row({ lastSkippedAt: new Date().toISOString() })]);
    await waitFor(() => expect(screen.getByText(/did not run/i)).toBeTruthy());
    expect(screen.getByText(/no reason was recorded/i)).toBeTruthy();
    expect(screen.queryByText(/does not recognize it/i)).toBeNull();
  });

  it('says nothing when no skip was recorded (negative control)', async () => {
    renderRows([row({ lastRunAt: new Date().toISOString(), lastRunId: 'r1' })]);
    await waitFor(() => expect(screen.getByText(/last run/i)).toBeTruthy());
    expect(screen.queryByText(/did not run/i)).toBeNull();
  });
});
