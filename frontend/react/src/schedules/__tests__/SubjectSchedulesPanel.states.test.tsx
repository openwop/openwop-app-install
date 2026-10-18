import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as confirmModule from '../../ui/confirm.js';

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

function mkClient(list: SubjectSchedulesClient['list']): SubjectSchedulesClient {
  return {
    list,
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
    renderPanel(mkClient(() => new Promise<SubjectScheduleRow[]>(() => {})));
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

/**
 * ADR 0787 — the panel against the new backend contract (`SCTUX-2/3/5/8`).
 */
describe('SubjectSchedulesPanel — ADR 0787 contract', () => {
  const base: SubjectScheduleRow = { jobId: 'j1', cronExpr: '0 9 * * *', enabled: true, workflowId: 'wf-1', nextFireAt: Date.now() + 3_600_000 };
  function renderWith(rows: SubjectScheduleRow[], client: Partial<SubjectSchedulesClient>, workflows = ['wf-1', 'wf-2']): SubjectSchedulesClient {
    const full: SubjectSchedulesClient = {
      list: async () => rows,
      create: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      ...client,
    };
    render(
      <MemoryRouter>
        <SubjectSchedulesPanel client={full} workflows={workflows} copy={{ emptyBody: EMPTY_SENTINEL, helper: 'helper', noWorkflowsHint: 'no-workflows' }} />
      </MemoryRouter>,
    );
    return full;
  }

  it('Run now says WHY no run started — never "no workflow bound" for a skip (SCTUX-2)', async () => {
    renderWith([base], { trigger: vi.fn(async () => ({ skipped: 'budget' })) });
    const run = await screen.findByRole('button', { name: /run now/i });
    run.click();
    await waitFor(() => expect(screen.getByText(/autonomous-run budget/i)).toBeTruthy());
    expect(screen.queryByText(/no workflow bound/i)).toBeNull();
  });

  it('a cadence with no further slot says so — not "did not run", not "didn’t parse" (SCTUX-3)', async () => {
    const { nextFireAt: _drop, ...noNext } = base;
    void _drop;
    renderWith([{ ...noNext, cronExpr: '0 0 29 2 *', lastSkippedAt: new Date().toISOString(), lastSkipReason: 'no-next-fire' }], {});
    await waitFor(() => expect(screen.getByText(/no future time matches this cadence/i)).toBeTruthy());
    expect(screen.queryByText(/did not run/i)).toBeNull();
    expect(screen.queryByText(/didn.t parse/i)).toBeNull();
  });

  it('feature-disabled is a known reason, not "unrecognized" (SCTUX-3)', async () => {
    renderWith([{ ...base, lastSkippedAt: new Date().toISOString(), lastSkipReason: 'feature-disabled' }], {});
    await waitFor(() => expect(screen.getByText(/turned off for this workspace/i)).toBeTruthy());
    expect(screen.queryByText(/does not recognize it/i)).toBeNull();
  });

  it('ADR 0775 P3 — agent-paused is a known reason that says how to resume, not "unrecognized"', async () => {
    renderWith([{ ...base, lastSkippedAt: new Date().toISOString(), lastSkipReason: 'agent-paused' }], {});
    await waitFor(() => expect(screen.getByText(/agent it runs as is paused/i)).toBeTruthy());
    expect(screen.queryByText(/does not recognize it/i)).toBeNull();
  });

  it('ADR 0775 P3b — policy-denied and awaiting-approval are known reasons', async () => {
    renderWith([
      { ...base, jobId: 'j-deny', lastSkippedAt: new Date().toISOString(), lastSkipReason: 'policy-denied' },
      { ...base, jobId: 'j-hold', lastSkippedAt: new Date().toISOString(), lastSkipReason: 'awaiting-approval' },
    ], {});
    await waitFor(() => expect(screen.getByText(/on its never list/i)).toBeTruthy());
    expect(screen.getByText(/waiting for approval/i)).toBeTruthy();
    expect(screen.queryByText(/does not recognize it/i)).toBeNull();
  });

  it('ADR 0820 §7 — a plan-lapsed job reads "Paused — plan lapsed" with a store link and no next-run promise', async () => {
    renderWith([{ ...base, lastSkippedAt: new Date().toISOString(), lastSkipReason: 'plan-lapsed', planLapsed: { featureId: 'crm' } }], {});
    await waitFor(() => expect(screen.getByText(/paused — plan lapsed/i)).toBeTruthy());
    expect(screen.getByText(/resumes by itself/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /see plans/i }).getAttribute('href')).toBe('/marketplace/bundles?feature=crm');
    expect(screen.queryByText(/^active$/i)).toBeNull();
    expect(screen.queryByText(/next run/i)).toBeNull();
  });

  it('ADR 0820 §7 — once the server stops reporting the lapse (re-granted), the row is Active again with no lapse copy (control)', async () => {
    renderWith([{ ...base, lastSkippedAt: new Date().toISOString(), lastSkipReason: 'plan-lapsed' }], {});
    await waitFor(() => expect(screen.getByText(/^active$/i)).toBeTruthy());
    expect(screen.queryByText(/paused — plan lapsed/i)).toBeNull();
    // The recorded skip is still a KNOWN reason, never "unrecognized".
    expect(screen.getByText(/your plan no longer includes/i)).toBeTruthy();
    expect(screen.queryByText(/does not recognize it/i)).toBeNull();
  });

  it('an edit that changes only the workflow sends ONLY the workflow — a custom cadence and its zone survive (SCTUX-5)', async () => {
    const update = vi.fn<SubjectSchedulesClient['update']>(async () => undefined);
    renderWith([{ ...base, cronExpr: '0 8 * * *', timezone: 'Europe/Paris' }], { update });
    (await screen.findByRole('button', { name: /edit/i })).click();
    await waitFor(() => expect(document.querySelector('.agentsched-edit-row')).not.toBeNull());
    const row = document.querySelector('.agentsched-edit-row')!;
    const [wfSelect, cadenceSelect] = Array.from(row.querySelectorAll('select'));
    // The untouched cadence select holds "Keep current", not a preset.
    expect((cadenceSelect as HTMLSelectElement).value).toBe('keep');
    fireEvent.change(wfSelect!, { target: { value: 'wf-2' } });
    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const [, patch] = update.mock.calls[0]!;
    expect(patch).toEqual({ workflowId: 'wf-2' });
  });

  it('a double click fires Run now ONCE (SCTUX-8)', async () => {
    let release!: () => void;
    const trigger = vi.fn<NonNullable<SubjectSchedulesClient['trigger']>>(() => new Promise((r) => { release = () => r({ runId: 'run-1' }); }));
    renderWith([base], { trigger });
    const run = await screen.findByRole('button', { name: /run now/i });
    run.click();
    run.click();
    release();
    await waitFor(() => expect(screen.getByText(/view run/i)).toBeTruthy());
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});

describe('ADR 0815 D4 (grade-ux ORGUX-4) — a job paused because its member left', () => {
  const row: SubjectScheduleRow = { jobId: 'j1', cronExpr: '0 9 * * *', workflowId: 'wf-1', enabled: false, pausedReason: 'acting_member_removed' };
  it('is labelled, cannot be run now, and resuming asks before it re-owns', async () => {
    const confirmSpy = vi.spyOn(confirmModule, 'confirm').mockResolvedValue(false);
    const client: SubjectSchedulesClient = {
      list: vi.fn<SubjectSchedulesClient['list']>(async () => [row]),
      create: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      trigger: vi.fn<NonNullable<SubjectSchedulesClient['trigger']>>(async () => ({})),
    };
    render(
      <MemoryRouter>
        <SubjectSchedulesPanel client={client} workflows={['wf-1']} copy={{ emptyBody: EMPTY_SENTINEL, helper: 'helper', noWorkflowsHint: 'no-workflows' }} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Paused — the person it ran as left/)).toBeTruthy());
    expect((screen.getByRole('button', { name: /Run now/i }) as HTMLButtonElement).disabled).toBe(true);
    screen.getByRole('button', { name: /Resume/i }).click();
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(client.update).not.toHaveBeenCalled(); // declined → nothing re-owned
  });
});
