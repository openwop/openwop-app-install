/**
 * ADR 0987 D6 — the run-admission panel reports what it read, and only that.
 *
 * The near-misses this guards:
 *   a failed read           must not render as "no refusals"
 *   a 403 on THIS read      must not claim the panels beside it are operator-only,
 *                           and must not raise the hub's page-level error
 *   a bounded holding count must say "at least" at its bound
 *   the concurrency rows    must not show "no refusals": the store counts both
 *                           families together, so a per-row 0 was never measured
 *   the hub's Refresh       must reach this panel's read
 *   a failed REFRESH        keeps the last reading and says it is stale, never
 *                           a fresh-looking card and never the "unavailable" card
 *
 * Sabotage notes (each run red, 2026-10-31):
 *  - render `admissionHolding` for both branches → red ("at least");
 *  - treat `refusals: null` as `{}` → red (concurrency rows claim "no refusals");
 *  - fold this read into the hub's `allSettled` page error → red ("a failed read");
 *  - load once on mount, ignoring `refreshToken` → red ("Refresh re-reads").
 * Re-measured w85: also red on a wrong refusal count, a posture word swapped, the
 * stale Notice dropped, a 403 read as a failure, the card's Refresh not wired,
 * `cap 0` not shown as off, and the mount reading twice (`refreshToken >= 0`).
 * The concurrency total is a SUM over `concurrencyRefusals`; the store emits one
 * reason today (`at_cap`, host/runInsert.ts), so sum and first-value are the same
 * on production-shaped data and that mutant is equivalent, not an untested claim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GlobalLiveRegion } from '../../../ui/announce.js';

type Client = typeof import('../../../client/operationsClient.js');
const api = vi.hoisted(() => ({
  getHealthSummary: vi.fn<Client['getHealthSummary']>(),
  getDlqSummary: vi.fn<Client['getDlqSummary']>(),
  getOutboxSummary: vi.fn<Client['getOutboxSummary']>(),
  getSloSummary: vi.fn<Client['getSloSummary']>(),
  getAdmissionSummary: vi.fn<Client['getAdmissionSummary']>(),
}));
vi.mock('../../../client/operationsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});

import { OperationsHubPage } from '../OperationsHubPage.js';
import { OperationsRequestError, type AdmissionSummary, type DlqSummary, type HealthSummary, type OutboxSummary, type SloSummary } from '../../../client/operationsClient.js';
import { messages as en } from '../i18n/en.js';

const HEALTH: HealthSummary = {
  status: 'ready', version: '1.0.0',
  checks: { config: { ok: true }, storage: { ok: true } },
  sse: { totalStreams: 0, keys: 0, max: 10, top: [] },
  rateLimits: { ipReqsPerMin: 60, sessionRunsPerMin: 1, sessionRunsPerDay: 1, sessionConcurrent: 1, ipRunsPerDay: 1, mcpPrincipalReqsPerMin: 1 },
  daemon: {}, perInstance: false, fetchedAt: '2026-10-31T00:00:00Z',
};
const DLQ: DlqSummary = { subjects: [], backend: 'durable', perInstance: false, pointInTime: true, fetchedAt: '2026-10-31T00:00:00Z' };
const OUTBOX: OutboxSummary = {
  counts: { pending: 0, dead: 0 }, oldestPendingCreatedAt: null, oldestPendingAgeS: null,
  dead: [], deadSample: { limit: 20, truncated: false }, perInstance: false, fetchedAt: '2026-10-31T00:00:00Z',
};
const SLO: SloSummary = {
  source: 'unavailable', window: { kind: 'process_uptime', startedAt: null, seconds: null }, perInstance: true,
  series: { count: 0, limit: 20_000, overflowed: false }, rows: [], alerts: [], runbookDoc: 'docs/runbooks/slo-alerts.md', fetchedAt: '2026-10-31T00:00:00Z',
};

function admission(over: Partial<AdmissionSummary> = {}): AdmissionSummary {
  return {
    profile: 'strict',
    families: [
      { family: 'concurrency.session', cap: 5, posture: 'transactional', refusals: null },
      { family: 'runs.session.minute', cap: 10, windowS: 60, posture: 'closed', refusals: { session_runs_per_min: 3 } },
      { family: 'runs.ip.day', cap: 0, windowS: 86_400, posture: 'closed', refusals: {} },
      { family: 'plan.monthly', cap: null, posture: 'closed', refusals: {} },
    ],
    holding: { count: 7, atLeast: false, limit: 1000 },
    concurrencyRefusals: { at_cap: 2 },
    windowUnavailable: 0,
    perInstance: true,
    fetchedAt: '2026-10-31T00:00:00Z',
    ...over,
  };
}

function renderHub(): void {
  render(
    <MemoryRouter>
      <GlobalLiveRegion />
      <div data-testid="page"><OperationsHubPage /></div>
    </MemoryRouter>,
  );
}
const page = (): ReturnType<typeof within> => within(screen.getByTestId('page'));
/** The admission section, found by its heading, so assertions cannot match a neighbour. */
const panel = (): ReturnType<typeof within> => within(page().getByRole('heading', { name: en.admissionHeading }).closest('section') as HTMLElement);

beforeEach(() => {
  vi.clearAllMocks();
  api.getHealthSummary.mockResolvedValue(HEALTH);
  api.getDlqSummary.mockResolvedValue(DLQ);
  api.getOutboxSummary.mockResolvedValue(OUTBOX);
  api.getSloSummary.mockResolvedValue(SLO);
});
afterEach(() => cleanup());

describe('ADR 0987 D6 — run admission panel', () => {
  it('shows the profile, holding count, caps, postures and refusals it read', async () => {
    api.getAdmissionSummary.mockResolvedValue(admission());
    renderHub();
    expect(await panel().findByText(en.admissionProfileStrict)).toBeTruthy();
    expect(panel().getByText('Runs holding a slot: 7')).toBeTruthy();
    expect(panel().getByText(en.admissionPerInstance)).toBeTruthy();
    expect(panel().getByText('cap 10')).toBeTruthy();
    expect(panel().getByText(en.admissionCapOff)).toBeTruthy();
    expect(panel().getByText(en.admissionCapPerPlan)).toBeTruthy();
    // The refusal chip carries the COUNT it read, beside its reason code.
    expect(panel().getByText('session_runs_per_min').closest('span')?.textContent).toBe('refused 3 · session_runs_per_min');
    // Every posture is a word: three window/plan families fail closed (strict), the
    // concurrency family is counted in the run insert.
    expect(panel().getAllByText(en.admissionPostureClosed)).toHaveLength(3);
    expect(panel().getAllByText(en.admissionPostureTransactional)).toHaveLength(1);
    expect(panel().queryByText(en.admissionPostureOpen)).toBeNull();
    expect(panel().getByText('Concurrency refusals (sessions and keys together): 2')).toBeTruthy();
    // The concurrency row shows no per-row refusal chip: only the two window/plan
    // rows with `{}` say "no refusals".
    expect(panel().getAllByText(en.admissionNoRefusals)).toHaveLength(2);
  });

  it('says "at least" when the bounded holding count hit its limit', async () => {
    api.getAdmissionSummary.mockResolvedValue(admission({ holding: { count: 1000, atLeast: true, limit: 1000 } }));
    renderHub();
    expect(await panel().findByText('Runs holding a slot: at least 1,000')).toBeTruthy();
  });

  it('a failed read says so and never reads as "no refusals"', async () => {
    api.getAdmissionSummary.mockRejectedValue(new Error('boom'));
    renderHub();
    expect(await panel().findByText(en.admissionUnavailableTitle)).toBeTruthy();
    expect(panel().queryByText(en.admissionNoRefusals)).toBeNull();
    // This panel's failure stays in this panel: the hub's page-level error is for
    // the reads the hub owns.
    expect(page().queryByText('boom')).toBeNull();
    // The card's own Refresh re-runs this read, and a success replaces the card.
    api.getAdmissionSummary.mockResolvedValue(admission());
    fireEvent.click(panel().getByRole('button', { name: en.refresh }));
    expect(await panel().findByText(en.admissionProfileStrict)).toBeTruthy();
    expect(panel().queryByText(en.admissionUnavailableTitle)).toBeNull();
  });

  it('a 403 here is operator-only for this panel alone, and raises no page error', async () => {
    api.getAdmissionSummary.mockRejectedValue(new OperationsRequestError('nope', 403));
    renderHub();
    await waitFor(() => expect(panel().queryByText(en.operatorOnlyTitle)).toBeTruthy());
    expect(page().getByText(en.statusReady)).toBeTruthy();
    expect(page().queryAllByText(en.operatorOnlyTitle)).toHaveLength(1);
    expect(page().queryByText('nope')).toBeNull();
  });

  it("the hub's Refresh re-reads this panel", async () => {
    api.getAdmissionSummary.mockResolvedValue(admission());
    renderHub();
    await panel().findByText(en.admissionProfileStrict);
    expect(api.getAdmissionSummary).toHaveBeenCalledTimes(1);
    api.getAdmissionSummary.mockResolvedValue(admission({ profile: 'evaluation' }));
    fireEvent.click(page().getByRole('button', { name: en.refresh }));
    expect(await panel().findByText(en.admissionProfileEvaluation)).toBeTruthy();
    expect(api.getAdmissionSummary).toHaveBeenCalledTimes(2);
    expect(panel().queryByText(en.admissionStale)).toBeNull();
    // A refresh that FAILS keeps the last reading and says it is stale.
    api.getAdmissionSummary.mockRejectedValue(new Error('flaky'));
    fireEvent.click(page().getByRole('button', { name: en.refresh }));
    expect(await panel().findByText(en.admissionStale)).toBeTruthy();
    expect(api.getAdmissionSummary).toHaveBeenCalledTimes(3);
    expect(panel().getByText(en.admissionProfileEvaluation)).toBeTruthy();
    expect(panel().queryByText(en.admissionUnavailableTitle)).toBeNull();
  });
});
