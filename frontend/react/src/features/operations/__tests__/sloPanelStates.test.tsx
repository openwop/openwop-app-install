/**
 * ADR 0556 P2 — the SLO panel reports the state it is actually in.
 *
 * This panel's whole job is to be honest about what it can and cannot see, so
 * the states are asserted as MUTUALLY EXCLUSIVE renders rather than as "the
 * right thing appeared somewhere". Every case below also asserts the WRONG
 * neighbour is absent, because the failures that matter here are all
 * near-misses:
 *
 *   read failed        must not render as "no alerts"
 *   collector off      must not render as "no alerts" — the trap this phase
 *                      exists to avoid: a host with no reader records every
 *                      blocked effect it suffers and can report none of them
 *   nothing measured   must not render as "met"
 *   stale              must not render as live
 *   a 403 on THIS read must not claim the panels beside it are operator-only
 *
 * It follows the UX-OPS-1 precedent in `opsHealthHonesty.test.tsx` exactly:
 * per-panel outcome state, `allSettled` so one read cannot poison another, and
 * failure detected structurally by HTTP status rather than by message text.
 *
 * w52: every fixture is typed against the client's own interfaces (HEALTH, DLQ
 * and OUTBOX were untyped), and the mocks are typed.
 *
 * w117: each case waits for the outbox panel (read in the SAME `allSettled`
 * batch, never a probe target) and then asserts exact counts inside the SLO
 * section, so a sabotage reds on a value rather than on a lookup that times out.
 * The queue-source case carries a second, non-queue row the label must skip.
 * Sabotage that turns it red (w117 probes): the failed card, the 403 split (either
 * direction), the collector-off card, the empty card, the stale and degraded and
 * not-measurable state words, the stale-refresh Notice, keeping the last reading,
 * the alert count, severity word, runbook path, per-instance chip, window chip,
 * sample count, ratio formatting, overflow chip, queue-source label, and the
 * why-not chip.
 *
 * TST-OAI-2 (2026-11-22, user decision): the empty card is also chosen when the
 * unjudged rows are a mix of `empty` and `not_projectable`, the fresh-instance
 * shape. Red when the `not_projectable` half of that choice is dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GlobalLiveRegion } from '../../../ui/announce.js';

type Client = typeof import('../../../client/operationsClient.js');
const api = vi.hoisted(() => ({
  getHealthSummary: vi.fn<Client['getHealthSummary']>(),
  getDlqSummary: vi.fn<Client['getDlqSummary']>(),
  getOutboxSummary: vi.fn<Client['getOutboxSummary']>(),
  getKanbanWorkItemDeliverySummary: vi.fn<Client['getKanbanWorkItemDeliverySummary']>(),
  getSloSummary: vi.fn<Client['getSloSummary']>(),
  getAdmissionSummary: vi.fn<Client['getAdmissionSummary']>(),
}));
vi.mock('../../../client/operationsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});

import { OperationsHubPage } from '../OperationsHubPage.js';
import { OperationsRequestError, type AdmissionSummary, type DlqSummary, type HealthSummary, type KanbanWorkItemDeliverySummary, type OutboxSummary, type SloRow, type SloSummary } from '../../../client/operationsClient.js';
import { messages as en } from '../i18n/en.js';

const HEALTH: HealthSummary = {
  status: 'ready', version: '1.0.0',
  checks: { config: { ok: true }, storage: { ok: true } },
  sse: { totalStreams: 0, keys: 0, max: 10, top: [] },
  rateLimits: { ipReqsPerMin: 60, sessionRunsPerMin: 1, sessionRunsPerDay: 1, sessionConcurrent: 1, ipRunsPerDay: 1, mcpPrincipalReqsPerMin: 1 },
  daemon: {}, perInstance: false, fetchedAt: '2026-08-17T00:00:00Z',
};
const DLQ: DlqSummary = { subjects: [], backend: 'durable', perInstance: false, pointInTime: true, fetchedAt: '2026-08-17T00:00:00Z' };
const OUTBOX: OutboxSummary = {
  counts: { pending: 0, dead: 0 }, oldestPendingCreatedAt: null, oldestPendingAgeS: null,
  dead: [], deadSample: { limit: 20, truncated: false }, perInstance: false, fetchedAt: '2026-08-17T00:00:00Z',
};
const KANBAN_DELIVERY: KanbanWorkItemDeliverySummary = {
  queue: { pending: 0, claimed: 0, delivered: 0, deadLettered: 0, oldestPendingCreatedAt: null, oldestPendingAgeS: null },
  outcomes: { started: 0, 'not-eligible': 0, deferred: 0, 'workflow-unresolved': 0, retried: 0, 'dead-lettered': 0 },
  window: { startsAt: '2026-08-16T00:00:00Z', endsAt: '2026-08-17T00:00:00Z' }, perInstance: false, fetchedAt: '2026-08-17T00:00:00Z',
};

function sloRow(over: Partial<SloRow> = {}): SloRow {
  return {
    id: 'R1', group: 'replay', metric: 'openwop.effect.blocked',
    sli: 'Effects blocked by the ADR 0531 replay backstop',
    state: 'healthy', source: 'local-scrape', observed: 0, target: 0, comparison: 'at_most', unit: 'count',
    sampleCount: 0, lastSampleAt: null, freshnessS: null, severity: 'page',
    runbook: 'docs/runbooks/slo-alerts.md#r1-blocked-effect',
    ...over,
  };
}
function summary(over: Partial<SloSummary> = {}): SloSummary {
  return {
    source: 'local-scrape',
    window: { kind: 'process_uptime', startedAt: '2026-08-17T11:00:00Z', seconds: 3600 },
    perInstance: true,
    series: { count: 12, limit: 20_000, overflowed: false },
    rows: [sloRow()],
    alerts: [],
    runbookDoc: 'docs/runbooks/slo-alerts.md',
    fetchedAt: '2026-08-17T12:00:00Z',
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
function page(): ReturnType<typeof within> {
  return within(screen.getByTestId('page'));
}
/** The SLO section alone, found by its heading, so a count cannot include a neighbour. */
function sloPanel(): ReturnType<typeof within> {
  return within(page().getByRole('heading', { name: en.sloHeading }).closest('section') as HTMLElement);
}
/** The hub's reads settle in ONE `allSettled` batch: once the outbox panel shows
 *  its answer, the SLO panel shows its final state too. */
async function settled(): Promise<void> {
  await page().findByText(en.outboxHealthy);
}

// ADR 0987 D6 — the hub's sixth read. Answered here so this file's panels stay the
// ones under test, and no live fetch leaves the test (ADR 0661).
const ADMISSION: AdmissionSummary = {
  profile: 'evaluation', families: [], holding: { count: 0, atLeast: false, limit: 1000 },
  concurrencyRefusals: {}, windowUnavailable: 0, perInstance: true, fetchedAt: '2026-10-31T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getHealthSummary.mockResolvedValue(HEALTH);
  api.getDlqSummary.mockResolvedValue(DLQ);
  api.getOutboxSummary.mockResolvedValue(OUTBOX);
  api.getKanbanWorkItemDeliverySummary.mockResolvedValue(KANBAN_DELIVERY);
  api.getAdmissionSummary.mockResolvedValue(ADMISSION);
});
afterEach(() => cleanup());

describe('ADR 0556 P2 — SLO panel states', () => {
  it('ERROR: a failed read says so and never claims there are no alerts', async () => {
    api.getSloSummary.mockRejectedValue(new Error('boom'));
    renderHub();
    await settled();
    expect(sloPanel().queryAllByText(en.sloUnavailableTitle)).toHaveLength(1);
    // The whole bug class in one assertion: an unread projection reported as a
    // clean one would read as "every objective is met".
    expect(sloPanel().queryByText(en.sloNoAlerts)).toBeNull();
    expect(sloPanel().queryByText(en.sloStateHealthy)).toBeNull();
  });

  it('FORBIDDEN: a 403 here claims operator-only for THIS panel alone', async () => {
    api.getSloSummary.mockRejectedValue(new OperationsRequestError('nope', 403));
    renderHub();
    await settled();
    expect(sloPanel().queryAllByText(en.operatorOnlyTitle)).toHaveLength(1);
    // The panels beside it answered fine and must still render — the
    // UX-OPS-1 lesson, applied to the fifth read.
    expect(page().queryAllByText(en.statusReady)).toHaveLength(1);
    expect(page().queryAllByText(en.dlqEmpty)).toHaveLength(1);
    // Exactly one operator-only card on the page: a global flag would produce more.
    expect(page().queryAllByText(en.operatorOnlyTitle)).toHaveLength(1);
  });

  it('UNKNOWN: the collector being off is its own card, not an empty or healthy one', async () => {
    api.getSloSummary.mockResolvedValue(summary({
      source: 'unavailable',
      window: { kind: 'process_uptime', startedAt: null, seconds: null },
      rows: [sloRow({ state: 'unknown', observed: null })],
    }));
    renderHub();
    await settled();
    expect(sloPanel().queryAllByText(en.sloCollectorOffTitle)).toHaveLength(1);
    // Distinguished from all three neighbours it could be mistaken for.
    expect(sloPanel().queryByText(en.sloEmptyTitle)).toBeNull();
    expect(sloPanel().queryByText(en.sloNoAlerts)).toBeNull();
    expect(sloPanel().queryByText(en.sloStateHealthy)).toBeNull();
  });

  it('EMPTY: a live reader with nothing measured says so, not "met"', async () => {
    api.getSloSummary.mockResolvedValue(summary({
      rows: [sloRow({ id: 'W1', state: 'empty', observed: null, sampleCount: 0 })],
    }));
    renderHub();
    await settled();
    expect(sloPanel().queryAllByText(en.sloEmptyTitle)).toHaveLength(1);
    expect(sloPanel().queryByText(en.sloStateHealthy)).toBeNull();
    // And it is NOT the collector-off card — one is fixed with an env var, the
    // other by waiting for traffic.
    expect(sloPanel().queryByText(en.sloCollectorOffTitle)).toBeNull();
  });

  it('EMPTY on a fresh instance: unmeasured rows beside unmeasurable ones still read "Nothing measured yet" (TST-OAI-2)', async () => {
    // The realistic first-boot projection: the catalog's projectable rows have no
    // samples yet, and its not-projectable rows never will. None of them is being
    // judged, so the panel must not render a table that reads as a verdict.
    api.getSloSummary.mockResolvedValue(summary({
      rows: [
        sloRow({ id: 'W1', state: 'empty', observed: null, sampleCount: 0 }),
        sloRow({ id: 'C2', state: 'not_projectable', observed: null, reason: 'needs an obligation age no counter carries' }),
      ],
    }));
    renderHub();
    await settled();
    expect(sloPanel().queryAllByText(en.sloEmptyTitle)).toHaveLength(1);
    expect(sloPanel().queryByText(en.sloStateNotProjectable)).toBeNull();
    expect(sloPanel().queryByText(en.sloNoAlerts)).toBeNull();
    expect(sloPanel().queryByText(en.sloCollectorOffTitle)).toBeNull();
  });

  it('STALE: a row whose series went quiet is warned, not shown as met', async () => {
    api.getSloSummary.mockResolvedValue(summary({
      rows: [sloRow({
        id: 'Q2', metric: 'openwop.dispatch.outbox.oldest_age', state: 'stale',
        observed: 3, target: 120, unit: 'seconds', freshnessS: 60, sampleCount: 1,
      })],
      alerts: [{ id: 'Q2', severity: 'ticket', kind: 'stale', summary: 'no sample within 60s', runbook: 'docs/runbooks/slo-alerts.md#q2-outbox-oldest-age' }],
    }));
    renderHub();
    await settled();
    expect(sloPanel().queryAllByText(en.sloStateStale)).toHaveLength(1);
    // 3s is comfortably under the 120s target — the arithmetic says "fine" and
    // the freshness check is the only thing that does not.
    expect(sloPanel().queryByText(en.sloStateHealthy)).toBeNull();
    expect(sloPanel().queryAllByText('1 alerts')).toHaveLength(1);
  });

  it('STALE REFRESH: a failed refresh keeps the last-known rows and labels them', async () => {
    api.getSloSummary.mockResolvedValueOnce(summary());
    renderHub();
    await settled();
    expect(sloPanel().queryAllByText(en.sloNoAlerts)).toHaveLength(1);
    expect(sloPanel().queryAllByText(en.sloStale)).toHaveLength(0);
    // A later refresh fails. The previous answer is still the most recent truth
    // available, so it is kept — and labelled, which is the §4.6 `stale` rule.
    // The refresh's own settle signal is a NEW outbox count.
    api.getSloSummary.mockRejectedValue(new Error('later failure'));
    api.getOutboxSummary.mockResolvedValue({ ...OUTBOX, counts: { pending: 4, dead: 0 } });
    fireEvent.click(screen.getByRole('button', { name: en.refresh }));
    await page().findByText('4 waiting to start');
    expect(sloPanel().queryAllByText(en.sloStale)).toHaveLength(1);
    expect(sloPanel().queryAllByText(en.sloNoAlerts)).toHaveLength(1);
    // NOT the "could not be read" card — that is for having nothing at all.
    expect(sloPanel().queryByText(en.sloUnavailableTitle)).toBeNull();
  });

  it('BREACHING: renders the alert with its severity as a WORD and the runbook path', async () => {
    api.getSloSummary.mockResolvedValue(summary({
      rows: [sloRow({ state: 'breaching', observed: 2, sampleCount: 2 })],
      alerts: [{ id: 'R1', severity: 'page', kind: 'breach', summary: 'blocked effects is 2 against a target of ≤ 0.', runbook: 'docs/runbooks/slo-alerts.md#r1-blocked-effect' }],
    }));
    renderHub();
    await settled();
    expect(sloPanel().queryAllByText(en.sloStateBreaching)).toHaveLength(1);
    // WCAG 1.4.1 — severity is a word, never colour alone.
    expect(sloPanel().queryAllByText(en.sloSeverityPage)).toHaveLength(1);
    expect(sloPanel().queryAllByText('docs/runbooks/slo-alerts.md#r1-blocked-effect')).toHaveLength(1);
    expect(sloPanel().queryByText(en.sloNoAlerts)).toBeNull();
    expect(sloPanel().queryAllByText('1 alerts')).toHaveLength(1);
  });

  it('HEALTHY: shows the window and always says the reading is per-instance', async () => {
    api.getSloSummary.mockResolvedValue(summary({
      rows: [sloRow({ id: 'W1', state: 'healthy', observed: 0.99, target: 0.97, comparison: 'at_least', unit: 'ratio', sampleCount: 100 })],
    }));
    renderHub();
    await settled();
    expect(sloPanel().queryAllByText(en.sloNoAlerts)).toHaveLength(1);
    expect(sloPanel().queryAllByText(en.sloStateHealthy)).toHaveLength(1);
    // The honesty the panel must never drop: `docs/SLO.md` declares 28 days
    // rolling and fleet-wide, and this is neither.
    expect(sloPanel().queryAllByText(en.sloPerInstance)).toHaveLength(1);
    expect(sloPanel().queryAllByText('Since this instance started · 3600s')).toHaveLength(1);
    // A ratio's sample count travels with it — 99% over 100 is evidence, over 3 is not.
    expect(sloPanel().queryAllByText('100 samples')).toHaveLength(1);
    expect(sloPanel().queryAllByText('now 99.00%')).toHaveLength(1);
  });

  it('DEGRADED: an overflowed series is warned, never shown as a number', async () => {
    // The SDK folds series past its cardinality ceiling into an unattributable
    // bucket, silently. A ratio over that is arithmetically fine and
    // semantically garbage, so the panel must refuse rather than render it.
    api.getSloSummary.mockResolvedValue(summary({
      series: { count: 20_000, limit: 20_000, overflowed: true },
      rows: [sloRow({ id: 'W1', state: 'degraded', observed: null, reason: 'exceeded its cardinality ceiling' })],
      alerts: [{ id: 'W1', severity: 'ticket', kind: 'degraded', summary: 'cardinality ceiling', runbook: 'docs/runbooks/slo-alerts.md#w1-run-success-rate' }],
    }));
    renderHub();
    await settled();
    expect(sloPanel().queryAllByText(en.sloStateDegraded)).toHaveLength(1);
    // Distinguished from a breach: nothing is known to be failing.
    expect(sloPanel().queryByText(en.sloStateBreaching)).toBeNull();
    expect(sloPanel().queryByText(en.sloStateHealthy)).toBeNull();
    // And the ceiling itself is on screen, because it is what an operator fixes.
    expect(sloPanel().queryAllByText(/^Series ceiling reached/)).toHaveLength(1);
  });

  it('QUEUE SOURCE: a dispatch row says it came from the queue table', async () => {
    // The same quantity is rendered by the outbox panel above. Labelling the
    // source is what stops an operator reading them as two disagreeing numbers.
    // R1 reads the local scrape and must NOT carry the label.
    api.getSloSummary.mockResolvedValue(summary({
      rows: [
        sloRow({ id: 'R1' }),
        sloRow({
          id: 'Q2', metric: 'openwop.dispatch.outbox.oldest_age', state: 'healthy',
          source: 'dispatch-outbox-stats', observed: 3, target: 120, unit: 'seconds', sampleCount: 1,
        }),
      ],
    }));
    renderHub();
    await settled();
    const labels = sloPanel().queryAllByText(en.sloFromQueueTable);
    expect(labels).toHaveLength(1);
    expect(labels[0]?.closest('li')?.querySelector('.chip')?.textContent).toBe('Q2');
  });

  it('NOT MEASURABLE: shows the row with its reason and raises no alert', async () => {
    api.getSloSummary.mockResolvedValue(summary({
      rows: [
        sloRow({ id: 'W1', state: 'healthy', observed: 1, target: 0.97, comparison: 'at_least', unit: 'ratio', sampleCount: 10 }),
        sloRow({ id: 'C2', state: 'not_projectable', observed: null, reason: 'needs an obligation age no counter carries' }),
      ],
    }));
    renderHub();
    await settled();
    expect(sloPanel().queryAllByText(en.sloStateNotProjectable)).toHaveLength(1);
    const whyNot = sloPanel().queryAllByText(en.sloWhyNot);
    expect(whyNot).toHaveLength(1);
    expect(whyNot[0]?.getAttribute('title')).toBe('needs an obligation age no counter carries');
    // It is a published objective the panel deliberately does not judge — so it
    // is visible, and it does not page anyone.
    expect(sloPanel().queryAllByText(en.sloNoAlerts)).toHaveLength(1);
  });
});
