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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GlobalLiveRegion } from '../../../ui/announce.js';

const api = vi.hoisted(() => ({
  getHealthSummary: vi.fn(),
  getDlqSummary: vi.fn(),
  getOutboxSummary: vi.fn(),
  getSloSummary: vi.fn(),
}));
vi.mock('../../../client/operationsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});

import { OperationsHubPage } from '../OperationsHubPage.js';
import { OperationsRequestError, type SloRow, type SloSummary } from '../../../client/operationsClient.js';
import { messages as en } from '../i18n/en.js';

const HEALTH = {
  status: 'ready' as const, version: '1.0.0',
  checks: { config: { ok: true }, storage: { ok: true } },
  sse: { totalStreams: 0, keys: 0, max: 10, top: [] },
  rateLimits: { ipReqsPerMin: 60, sessionRunsPerMin: 1, sessionRunsPerDay: 1, sessionConcurrent: 1, ipRunsPerDay: 1, mcpPrincipalReqsPerMin: 1 },
  daemon: {}, perInstance: false, fetchedAt: '2026-08-17T00:00:00Z',
};
const DLQ = { subjects: [], backend: 'durable' as const, perInstance: false, pointInTime: true, fetchedAt: '2026-08-17T00:00:00Z' };
const OUTBOX = {
  counts: { pending: 0, dead: 0 }, oldestPendingCreatedAt: null, oldestPendingAgeS: null,
  dead: [], deadSample: { limit: 20, truncated: false }, perInstance: false, fetchedAt: '2026-08-17T00:00:00Z',
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

beforeEach(() => {
  vi.clearAllMocks();
  api.getHealthSummary.mockResolvedValue(HEALTH);
  api.getDlqSummary.mockResolvedValue(DLQ);
  api.getOutboxSummary.mockResolvedValue(OUTBOX);
});
afterEach(() => cleanup());

describe('ADR 0556 P2 — SLO panel states', () => {
  it('ERROR: a failed read says so and never claims there are no alerts', async () => {
    api.getSloSummary.mockRejectedValue(new Error('boom'));
    renderHub();
    expect(await page().findByText(en.sloUnavailableTitle)).toBeTruthy();
    // The whole bug class in one assertion: an unread projection reported as a
    // clean one would read as "every objective is met".
    expect(page().queryByText(en.sloNoAlerts)).toBeNull();
    expect(page().queryByText(en.sloStateHealthy)).toBeNull();
  });

  it('FORBIDDEN: a 403 here claims operator-only for THIS panel alone', async () => {
    api.getSloSummary.mockRejectedValue(new OperationsRequestError('nope', 403));
    renderHub();
    await waitFor(() => expect(page().queryAllByText(en.operatorOnlyTitle).length).toBeGreaterThan(0));
    // The three panels beside it answered fine and must still render — the
    // UX-OPS-1 lesson, applied to the fourth read.
    expect(page().getByText(en.statusReady)).toBeTruthy();
    expect(page().getByText(en.dlqEmpty)).toBeTruthy();
    // Exactly one operator-only card: a global flag would produce four.
    expect(page().queryAllByText(en.operatorOnlyTitle)).toHaveLength(1);
  });

  it('UNKNOWN: the collector being off is its own card, not an empty or healthy one', async () => {
    api.getSloSummary.mockResolvedValue(summary({
      source: 'unavailable',
      window: { kind: 'process_uptime', startedAt: null, seconds: null },
      rows: [sloRow({ state: 'unknown', observed: null })],
    }));
    renderHub();
    expect(await page().findByText(en.sloCollectorOffTitle)).toBeTruthy();
    // Distinguished from all three neighbours it could be mistaken for.
    expect(page().queryByText(en.sloEmptyTitle)).toBeNull();
    expect(page().queryByText(en.sloNoAlerts)).toBeNull();
    expect(page().queryByText(en.sloStateHealthy)).toBeNull();
  });

  it('EMPTY: a live reader with nothing measured says so, not "met"', async () => {
    api.getSloSummary.mockResolvedValue(summary({
      rows: [sloRow({ id: 'W1', state: 'empty', observed: null, sampleCount: 0 })],
    }));
    renderHub();
    expect(await page().findByText(en.sloEmptyTitle)).toBeTruthy();
    expect(page().queryByText(en.sloStateHealthy)).toBeNull();
    // And it is NOT the collector-off card — one is fixed with an env var, the
    // other by waiting for traffic.
    expect(page().queryByText(en.sloCollectorOffTitle)).toBeNull();
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
    expect(await page().findByText(en.sloStateStale)).toBeTruthy();
    // 3s is comfortably under the 120s target — the arithmetic says "fine" and
    // the freshness check is the only thing that does not.
    expect(page().queryByText(en.sloStateHealthy)).toBeNull();
    expect(page().getByText(en.sloAlertCount.replace('{{n}}', '1'))).toBeTruthy();
  });

  it('STALE REFRESH: a failed refresh keeps the last-known rows and labels them', async () => {
    api.getSloSummary.mockResolvedValueOnce(summary());
    renderHub();
    await page().findByText(en.sloNoAlerts);
    // A later refresh fails. The previous answer is still the most recent truth
    // available, so it is kept — and labelled, which is the §4.6 `stale` rule.
    api.getSloSummary.mockRejectedValue(new Error('later failure'));
    screen.getByRole('button', { name: en.refresh }).click();
    await waitFor(() => expect(page().queryAllByText(en.sloStale).length).toBeGreaterThan(0));
    expect(page().getByText(en.sloNoAlerts)).toBeTruthy();
    // NOT the "could not be read" card — that is for having nothing at all.
    expect(page().queryByText(en.sloUnavailableTitle)).toBeNull();
  });

  it('BREACHING: renders the alert with its severity as a WORD and the runbook path', async () => {
    api.getSloSummary.mockResolvedValue(summary({
      rows: [sloRow({ state: 'breaching', observed: 2, sampleCount: 2 })],
      alerts: [{ id: 'R1', severity: 'page', kind: 'breach', summary: 'blocked effects is 2 against a target of ≤ 0.', runbook: 'docs/runbooks/slo-alerts.md#r1-blocked-effect' }],
    }));
    renderHub();
    expect(await page().findByText(en.sloStateBreaching)).toBeTruthy();
    // WCAG 1.4.1 — severity is a word, never colour alone.
    expect(page().getByText(en.sloSeverityPage)).toBeTruthy();
    expect(page().getByText('docs/runbooks/slo-alerts.md#r1-blocked-effect')).toBeTruthy();
    expect(page().queryByText(en.sloNoAlerts)).toBeNull();
  });

  it('HEALTHY: shows the window and always says the reading is per-instance', async () => {
    api.getSloSummary.mockResolvedValue(summary({
      rows: [sloRow({ id: 'W1', state: 'healthy', observed: 0.99, target: 0.97, comparison: 'at_least', unit: 'ratio', sampleCount: 100 })],
    }));
    renderHub();
    expect(await page().findByText(en.sloNoAlerts)).toBeTruthy();
    expect(page().getByText(en.sloStateHealthy)).toBeTruthy();
    // The honesty the panel must never drop: `docs/SLO.md` declares 28 days
    // rolling and fleet-wide, and this is neither.
    expect(page().getByText(en.sloPerInstance)).toBeTruthy();
    expect(page().getByText(en.sloWindow.replace('{{n}}', '3600'))).toBeTruthy();
    // A ratio's sample count travels with it — 99% over 100 is evidence, over 3 is not.
    expect(page().getByText(en.sloSamples.replace('{{n}}', '100'))).toBeTruthy();
    expect(page().getByText(en.sloObserved.replace('{{value}}', '99.00%'))).toBeTruthy();
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
    expect(await page().findByText(en.sloStateDegraded)).toBeTruthy();
    // Distinguished from a breach: nothing is known to be failing.
    expect(page().queryByText(en.sloStateBreaching)).toBeNull();
    expect(page().queryByText(en.sloStateHealthy)).toBeNull();
    // And the ceiling itself is on screen, because it is what an operator fixes.
    expect(page().getByText(/Series ceiling reached/)).toBeTruthy();
  });

  it('QUEUE SOURCE: a dispatch row says it came from the queue table', async () => {
    // The same quantity is rendered by the outbox panel above. Labelling the
    // source is what stops an operator reading them as two disagreeing numbers.
    api.getSloSummary.mockResolvedValue(summary({
      rows: [sloRow({
        id: 'Q2', metric: 'openwop.dispatch.outbox.oldest_age', state: 'healthy',
        source: 'dispatch-outbox-stats', observed: 3, target: 120, unit: 'seconds', sampleCount: 1,
      })],
    }));
    renderHub();
    expect(await page().findByText(en.sloFromQueueTable)).toBeTruthy();
  });

  it('NOT MEASURABLE: shows the row with its reason and raises no alert', async () => {
    api.getSloSummary.mockResolvedValue(summary({
      rows: [
        sloRow({ id: 'W1', state: 'healthy', observed: 1, target: 0.97, comparison: 'at_least', unit: 'ratio', sampleCount: 10 }),
        sloRow({ id: 'C2', state: 'not_projectable', observed: null, reason: 'needs an obligation age no counter carries' }),
      ],
    }));
    renderHub();
    expect(await page().findByText(en.sloStateNotProjectable)).toBeTruthy();
    expect(page().getByText(en.sloWhyNot)).toBeTruthy();
    // It is a published objective the panel deliberately does not judge — so it
    // is visible, and it does not page anyone.
    expect(page().getByText(en.sloNoAlerts)).toBeTruthy();
  });
});
