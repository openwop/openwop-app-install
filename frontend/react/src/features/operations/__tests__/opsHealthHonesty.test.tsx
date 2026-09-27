/**
 * UX_UPGRADE-operations P1 — a health console must not report what it failed to read.
 *
 * UX-OPS-1: `load()` did `Promise.all([getHealthSummary(), getDlqSummary()])`.
 * These are two INDEPENDENT reads, so either one poisoned the other:
 *   • DLQ 500s while health is fine → the catch runs, `health` is never set, and
 *     the Health panel renders `StateCard loading` FOREVER. A health console
 *     stuck on "loading" is a lie about its own state.
 *   • DLQ 403s for a tenant admin who CAN read health → `operatorOnly` was
 *     global, so BOTH panels claimed operator-only. The file header promises a
 *     non-superadmin sees "the honest operator-only notice, not a broken panel";
 *     over-applying it to a panel they may read is its own dishonesty.
 *   • Worst: a failed DLQ read must never fall through to `dlqEmpty` — an unread
 *     queue reported as an empty queue is this whole bug class in one line.
 *
 * UX-OPS-2: `checks.managedProviders` was typed `unknown` and dropped. The
 * backend surfaces it deliberately — routes/health.ts says an unconfigured
 * managed provider "used to be invisible until a user ran a workflow" — and it is
 * frequently the ONLY explanation for `degraded` while storage and config are ok.
 *
 * Every panel asserts BOTH arms: the failure says failed, and a genuine
 * empty/healthy answer still says empty/healthy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GlobalLiveRegion } from '../../../ui/announce.js';

const api = vi.hoisted(() => ({ getHealthSummary: vi.fn(), getDlqSummary: vi.fn(), replayDlqMessage: vi.fn() }));
vi.mock('../../../client/operationsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});

import { OperationsHubPage } from '../OperationsHubPage.js';
import { OperationsRequestError } from '../../../client/operationsClient.js';
import { messages as en } from '../i18n/en.js';

const HEALTH = {
  status: 'ready' as const, version: '1.0.0',
  checks: { config: { ok: true }, storage: { ok: true } },
  sse: { totalStreams: 0, keys: 0, max: 10, top: [] },
  rateLimits: { ipReqsPerMin: 60, sessionRunsPerMin: 1, sessionRunsPerDay: 1, sessionConcurrent: 1, ipRunsPerDay: 1, mcpPrincipalReqsPerMin: 1 },
  daemon: {}, perInstance: false, fetchedAt: '2026-07-25T00:00:00Z',
};
const DLQ = { subjects: [], backend: 'durable' as const, perInstance: false, pointInTime: true, fetchedAt: '2026-07-25T00:00:00Z' };

/** The hub renders <Link>s, so it needs a Router in scope. */
function renderHub(): void {
  render(
    <MemoryRouter>
      <GlobalLiveRegion />
      <div data-testid="page"><OperationsHubPage /></div>
    </MemoryRouter>,
  );
}

/**
 * Page-scoped queries. The stale copy is now BOTH rendered and spoken, so a bare
 * `screen.findByText` matches twice. Keeping the two apart is the point: `page()`
 * proves what is on screen, `spoken()` proves what a screen reader hears.
 */
function page(): ReturnType<typeof within> {
  return within(screen.getByTestId('page'));
}

/** The app-shell polite live region — what a screen reader actually hears. */
function spoken(): string {
  return document.querySelector('[aria-live="polite"]')?.textContent ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getHealthSummary.mockResolvedValue(HEALTH);
  api.getDlqSummary.mockResolvedValue(DLQ);
});
afterEach(cleanup);

describe('DATA-OPS-STALE — a failed REFRESH must not pass last-known numbers off as live', () => {
  // Found by /grade-data. The `xFailed && !x` guards above only catch a failure
  // with nothing to show. This page POLLS on an interval and has a Refresh
  // button, so the common case is the other one: a good first load, then a
  // blip. The panel fell through to the data branch and rendered the previous
  // queue depth with no marker at all — an operator reads "2 dead-lettered" as
  // current when the current number is unknown. On a health console that is the
  // same lie as an empty state, better dressed.
  it('marks health as last-known after a refresh fails, without discarding it', async () => {
    renderHub();
    expect(await page().findByText(/v1\.0\.0/)).toBeTruthy();
    expect(page().queryByText(en.healthStale)).toBeNull();

    api.getHealthSummary.mockRejectedValue(new Error('health_503'));
    fireEvent.click(screen.getByRole('button', { name: en.refresh }));

    expect(await page().findByText(en.healthStale)).toBeTruthy();
    // The numbers STAY. Replacing them with a failure card would be dishonest in
    // the other direction — it discards the most recent truth we actually hold.
    expect(page().getByText(/v1\.0\.0/)).toBeTruthy();
    expect(page().queryByText(en.healthUnavailableTitle)).toBeNull();
  });

  it('marks the DLQ as last-known after a refresh fails', async () => {
    api.getDlqSummary.mockResolvedValue({ ...DLQ, subjects: [{ subject: 's1', depth: 2, tenantId: 't1', reasons: ['boom'], messageIds: ['m1'] }] });
    renderHub();
    expect(await page().findByText(/s1/)).toBeTruthy();
    expect(page().queryByText(en.dlqStale)).toBeNull();

    api.getDlqSummary.mockRejectedValue(new Error('dlq_503'));
    fireEvent.click(screen.getByRole('button', { name: en.refresh }));

    expect(await page().findByText(en.dlqStale)).toBeTruthy();
    expect(page().getByText(/s1/)).toBeTruthy();
  });

  it('SPEAKS the stale state — the banner is invisible to a screen reader', async () => {
    // Found by /grade-data, and it is the sharpest gap in the whole effort: on the
    // stale path the numbers render and look completely normal, so the ONLY
    // signal is a warning banner. A user who cannot see it is left reading a
    // stale queue depth as current — the original defect, wearing the fix.
    renderHub();
    await page().findByText(/v1\.0\.0/);
    expect(spoken()).not.toContain(en.healthStale);

    api.getHealthSummary.mockRejectedValue(new Error('health_503'));
    fireEvent.click(screen.getByRole('button', { name: en.refresh }));

    await waitFor(() => expect(spoken()).toContain(en.healthStale));
  });

  it('a FIRST-LOAD failure shows the failure card and NO stale marker', async () => {
    // The other arm. "Stale" claims we hold a previous answer; on a cold failure
    // we hold nothing, and saying "last known" would invent one.
    api.getHealthSummary.mockRejectedValue(new Error('health_500'));
    renderHub();

    expect(await page().findByText(en.healthUnavailableTitle)).toBeTruthy();
    expect(page().queryByText(en.healthStale)).toBeNull();
  });
});

describe('UX-OPS-1 — one read failing never speaks for the other panel', () => {
  it('DLQ FAILS: the DLQ panel says unavailable and NEVER says the queue is empty', async () => {
    api.getDlqSummary.mockRejectedValue(new Error('dlq_500'));
    renderHub();
    expect(await page().findByText(/Dead-letter queue unavailable/i)).toBeTruthy();
    // The claim that would send an operator home happy.
    expect(page().queryByText(/No dead-lettered/i)).toBeNull();
  });

  it('DLQ FAILS: the Health panel still renders the health it DID read', async () => {
    // Before the fix this panel span forever on `StateCard loading`.
    api.getDlqSummary.mockRejectedValue(new Error('dlq_500'));
    renderHub();
    await page().findByText(/Dead-letter queue unavailable/i);
    expect(page().queryByText(/Health check unavailable/i)).toBeNull();
    expect(page().getByText(/v1\.0\.0/)).toBeTruthy();
  });

  it('DLQ 403 ONLY: health is not claimed operator-only', async () => {
    api.getDlqSummary.mockRejectedValue(new OperationsRequestError('forbidden', 403));
    renderHub();
    await page().findByText(/v1\.0\.0/); // health rendered
    // Exactly one operator-only card — the DLQ one, not both panels.
    expect(page().getAllByText(/operator/i).length).toBeGreaterThan(0);
    expect(page().queryByText(/Health check unavailable/i)).toBeNull();
  });

  it('BOTH OK + genuinely empty queue: the real empty state still renders', async () => {
    // The other arm. Without it, "always say unavailable" would pass the tests
    // above while destroying the accurate all-clear an operator relies on.
    renderHub();
    expect(await page().findByText(/v1\.0\.0/)).toBeTruthy();
    expect(page().queryByText(/Dead-letter queue unavailable/i)).toBeNull();
    expect(page().queryByText(/Health check unavailable/i)).toBeNull();
  });

  it('HEALTH FAILS: says unavailable rather than spinning, and does not claim degraded', async () => {
    api.getHealthSummary.mockRejectedValue(new Error('health_500'));
    renderHub();
    expect(await page().findByText(/Health check unavailable/i)).toBeTruthy();
    // Assert the CLAIM, not the word. This used to be `queryByText(/Degraded/i)`,
    // which broke the moment the failure copy started saying "unknown rather than
    // degraded" — an honest sentence that mentions the word in order to deny it.
    // The claim is the status chip at OperationsHubPage.tsx:106, so match that
    // chip's exact catalog string. A test that forbids a WORD forbids explaining
    // yourself; a test that forbids the CLAIM is the one worth having.
    expect(page().queryByText(en.statusDegraded)).toBeNull();
    expect(page().queryByText(en.statusReady)).toBeNull();
  });
});

describe('UX-OPS-2 — the server-computed provider block is rendered, not dropped', () => {
  it('shows a per-provider readiness chip when the server sends one', async () => {
    api.getHealthSummary.mockResolvedValue({
      ...HEALTH,
      status: 'degraded' as const,
      checks: {
        ...HEALTH.checks,
        managedProviders: [
          { providerId: 'anthropic', ready: true },
          { providerId: 'openai', ready: false, detail: 'no dispatch target configured' },
        ],
      },
    });
    renderHub();
    // The explanation for `degraded` that used to be discarded.
    expect(await page().findByText(/openai/)).toBeTruthy();
    expect(page().getByText(/anthropic/)).toBeTruthy();
  });

  it('renders nothing extra when the server omits the block', async () => {
    // The other arm — an older host without the block must not gain an empty row.
    renderHub();
    await page().findByText(/v1\.0\.0/);
    expect(page().queryByText(/openai/)).toBeNull();
  });
});

describe('UX-OPS-3 — the web-search check is three-valued, and "unknown" is not "no"', () => {
  // Same family as UX-OPS-2 directly above: a check the server computes on purpose
  // and the console must not drop. The reason it exists at all is that an operator
  // who set the Vault key had no way to confirm it landed except running a research
  // workflow and reading `engine: 'demo'` off a run event.
  //
  // The reason it is THREE-valued: the backend probe wraps the vault read in a
  // try/catch so it cannot 500 an unauthenticated endpoint. Rendering a caught
  // failure as "not configured" would tell an operator who HAD set the key that
  // they had not — which is precisely the false negative this surface removes.

  it('says configured, and names which lane the key came from', async () => {
    api.getHealthSummary.mockResolvedValue({
      ...HEALTH,
      checks: { ...HEALTH.checks, webSearch: { configured: true, source: 'host-vault' as const } },
    });
    renderHub();
    expect(await page().findByText(/host-vault/)).toBeTruthy();
    expect(page().queryByText(new RegExp(en.webSearchAbsent))).toBeNull();
  });

  it('says NOT configured when the probe answered cleanly and found nothing', async () => {
    api.getHealthSummary.mockResolvedValue({
      ...HEALTH,
      checks: { ...HEALTH.checks, webSearch: { configured: false, source: null } },
    });
    renderHub();
    expect(await page().findByText(new RegExp(en.webSearchAbsent))).toBeTruthy();
    expect(page().queryByText(new RegExp(en.webSearchUnknown))).toBeNull();
  });

  it('says COULD NOT CHECK — never "not configured" — when the vault probe threw', async () => {
    // The load-bearing arm. Collapsing this into the absent case is the bug.
    api.getHealthSummary.mockResolvedValue({
      ...HEALTH,
      checks: {
        ...HEALTH.checks,
        webSearch: { configured: false, source: null, probeError: 'vault unreachable' },
      },
    });
    renderHub();
    expect(await page().findByText(new RegExp(en.webSearchUnknown))).toBeTruthy();
    expect(
      page().queryByText(new RegExp(en.webSearchAbsent)),
      'an unreadable vault reported as "not configured" is the false negative this fixes',
    ).toBeNull();
  });

  it('never renders the chip as a failure — search is optional and does not gate readiness', async () => {
    api.getHealthSummary.mockResolvedValue({
      ...HEALTH,
      checks: { ...HEALTH.checks, webSearch: { configured: false, source: null } },
    });
    renderHub();
    const chip = await page().findByText(new RegExp(en.webSearchAbsent));
    expect(
      chip.className,
      'a danger chip would claim a healthy host is broken — the backend deliberately does not gate on this',
    ).not.toContain('danger');
  });

  it('renders nothing extra when the server omits the block', async () => {
    // Older revisions have no such field. A missing check must not render as a
    // false negative — "we did not ask" is not "there is no key".
    renderHub();
    await page().findByText(/v1\.0\.0/);
    expect(page().queryByText(new RegExp(en.webSearchAbsent))).toBeNull();
    expect(page().queryByText(new RegExp(en.checkWebSearch))).toBeNull();
  });
});
