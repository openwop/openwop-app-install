/**
 * BI metrics — a FAILED workspace read must not be rendered as an ordinary load.
 *
 * `MetricsPage` consumes the shared `ui/useOrgSelection` seam correctly, but no
 * test failed when the seam itself was sabotaged: replacing the hook's
 * `setOrgsFailed(true)` with `setOrgs([])` — the exact idiom the hook exists to
 * kill — left the bi suite green while the page rendered a PERMANENT SKELETON.
 * That is this page's particular shape of the lie: `orgId` stays `''`, `load()`
 * returns early on `if (!orgId) return`, `rows` never leaves `null`, and the
 * metric list waits forever on a read that already failed and will never be
 * retried. This file drives the REAL page through the REAL
 * `client/accessClient.listOrgs`, so a regression in the shared seam is red here.
 *
 * Both polarities, because an "absent" assertion alone is vacuous — a page that
 * rendered nothing at all would satisfy it:
 *   - read FAILS   → the honest, retryable failure card
 *   - read SUCCEEDS → the genuine "No metrics yet" empty state still renders, and
 *     no failure card appears (including when the org list is truthfully empty)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, act, fireEvent } from '@testing-library/react';

// Spread the real module rather than replacing it: a bare factory drops every
// other export, so the day the page (or anything in its import graph) reaches
// for a second symbol from these modules it gets `undefined` — a failure that
// looks nothing like its cause. Matches the sibling guards' idiom.
vi.mock('../../../client/accessClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  // ADR 0661 — this factory OVERRIDES the shared `shared-read-seams.ts` mock of
  // accessClient, so the seam's `getEffectiveAccess` no longer applies and the real
  // one ran. A partial override re-opens the hole the seam closed; re-state it here.
  return { ...orig, listOrgs: vi.fn(), getEffectiveAccess: async () => ({ roles: [], scopes: [], basis: 'none' }) };
});
vi.mock('../../entities/entitiesClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listEntityTypes: vi.fn() };
});
vi.mock('../biClient.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../biClient.js')>();
  return {
    ...mod,
    listBiMetrics: vi.fn(),
    runBiMetric: vi.fn(),
    createBiMetric: vi.fn(),
    updateBiMetric: vi.fn(),
    deleteBiMetric: vi.fn(),
  };
});

import { listOrgs } from '../../../client/accessClient.js';
import { listEntityTypes } from '../../entities/entitiesClient.js';
import { listBiMetrics, createBiMetric, updateBiMetric, deleteBiMetric, runBiMetric } from '../biClient.js';
import { MetricsPage } from '../MetricsPage.js';

const mockOrgs = vi.mocked(listOrgs);
const mockTypes = vi.mocked(listEntityTypes);
const mockMetrics = vi.mocked(listBiMetrics);
const mockCreate = vi.mocked(createBiMetric);
const mockUpdate = vi.mocked(updateBiMetric);
const mockDelete = vi.mocked(deleteBiMetric);
const mockRun = vi.mocked(runBiMetric);

/** Fill the create form's two required controls (the ones `Save metric`'s
 *  `disabled` actually watches) — everything except the organization. */
const fillMetricForm = (): void => {
  fireEvent.click(screen.getByRole('button', { name: /New metric/i }));
  fireEvent.change(screen.getByLabelText('Metric id'), { target: { value: 'deal-win-rate' } });
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Deal win rate' } });
  fireEvent.change(screen.getByLabelText('Entity type'), { target: { value: 'crm.deal' } });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTypes.mockResolvedValue([]);
  mockMetrics.mockResolvedValue([]);
});
afterEach(cleanup);

describe('bi metrics — a failed workspace read is not a slow one', () => {
  it('read FAILS: the honest retryable card, not an endless skeleton', async () => {
    mockOrgs.mockRejectedValue(new Error('orgs_500'));
    render(<MetricsPage />);
    expect(await screen.findByText('Could not load your organizations')).toBeTruthy();
    expect(screen.getByText(
      'The metric list was never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The metric-catalog empty state makes a claim about data that was never read.
    expect(screen.queryByText('No metrics yet')).toBeNull();
  });

  it('read SUCCEEDS: the genuine "No metrics yet" empty state still renders', async () => {
    // Fully typed rather than `as never`: an escape hatch here would silently
    // survive a field being added to `Organization`, which is exactly the drift
    // a fixture should surface.
    mockOrgs.mockResolvedValue([{
      orgId: 'o1', tenantId: 't1', name: 'Acme', slug: 'acme',
      createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }]);
    mockMetrics.mockResolvedValue([]);
    render(<MetricsPage />);
    expect(await screen.findByText('No metrics yet')).toBeTruthy();
    // …and no failure disclosure, because nothing failed.
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });

  it('read SUCCEEDS but the tenant has no organizations: still not a failure claim', async () => {
    mockOrgs.mockResolvedValue([]);
    render(<MetricsPage />);
    await waitFor(() => expect(mockOrgs).toHaveBeenCalled());
    // Never accuse the read of failing when it plainly did not…
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    // …and this assertion is INVERTED from what it used to claim. It asserted
    // that "New metric" was still offered — "the page has work to offer even
    // with no org selected" — which was the defect written down as a
    // requirement. There is no work to offer: the CTA opened a form whose Save
    // returns on `if (!orgId …)`. The CTA was a SIBLING above the org-state
    // wrapper, so it escaped the ordering the wrapper exists to impose.
    expect(screen.queryByRole('button', { name: /New metric/i })).toBeNull();
  });

  it('read SUCCEEDS with []: the zero-ORGANIZATION state, never an endless skeleton (HG-1)', async () => {
    // The third state of a SUCCESSFUL read. `orgId` stays '', `load()` returns on
    // `if (!orgId) return`, `rows` never leaves `null` — so the loading branch had
    // no terminal condition. The server answered "none" and the screen said
    // "loading", which DESIGN.md §4.6 forbids: loading may only say it is loading,
    // and empty is the state that may instruct.
    mockOrgs.mockResolvedValue([]);
    render(<MetricsPage />);
    expect(await screen.findByText('No organizations')).toBeTruthy();
    expect(screen.getByText('Business metrics belong to an organization.')).toBeTruthy();
    // Nothing failed, so nothing claims it did.
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.queryByText('Could not load metrics')).toBeNull();
    // The a11y half of the defect: `SkeletonRows` is a `role="status"` live region
    // labelled "Loading…" whose children are aria-hidden, so a screen-reader user
    // was told permanently that work was in progress.
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(mockMetrics).not.toHaveBeenCalled();
  });
});

/**
 * ORG-HON-2 — the WRITE half. Every guard above pins the dependent READ
 * (`listBiMetrics` was never called). None of them pinned the half that would
 * mint a real data defect: a metric row keyed on an EMPTY organization id.
 *
 * This page is the sharpest instance of the shape, because the create affordance
 * sits ABOVE the org-state chain: "New metric" renders in the zero-organization
 * state, the form opens, and `Save metric`'s `disabled` watches only
 * `saving || !form.title || !form.entityType` — NOT `orgId`. So the control is
 * fully live with nothing to write to, and the ONLY thing standing between a
 * filled form and `createBiMetric('', 'deal-win-rate', …)` is one clause inside
 * the handler (`if (!orgId || !form) return`). A test that asserts the button's
 * label or its disabled attribute would not see that clause disappear; asserting
 * the CLIENT FUNCTION was never called does.
 */
describe('bi metrics — no organization, no write (ORG-HON-2)', () => {
  it('zero organizations: the create affordance is GONE and no metric is written', async () => {
    mockOrgs.mockResolvedValue([]);
    render(<MetricsPage />);
    expect(await screen.findByText('No organizations')).toBeTruthy();

    // Guard one, and it did not exist before: the CTA and the whole seven-field
    // form were SIBLINGS above the wrapper, so `OrgSelectionState` could not
    // withhold them. They are children now, so there is nothing to fill in and
    // nothing to disable.
    expect(screen.queryByRole('button', { name: /New metric/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save metric' })).toBeNull();
    expect(screen.queryByLabelText('Metric id')).toBeNull();
    // Guard two, the one that survives a restyle: the handler says no as well.
    // Kept even though the form is now unreachable — `save()`'s `if (!orgId ||
    // !form) return` is the defence that does not depend on this render tree.
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    // The other two org-scoped writes hang off table rows, and there is no table:
    // the org-state branch stands in for it. Pinned anyway — they are the same
    // `orgId`-keyed shape and the branch order that hides them is load-bearing.
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('positive control: with an organization, those same keystrokes DO write', async () => {
    // Without this, the assertion above could pass because the form never opened
    // or the button never enabled — i.e. for a reason that has nothing to do with
    // the org guard.
    mockOrgs.mockResolvedValue([{
      orgId: 'o1', tenantId: 't1', name: 'Acme', slug: 'acme',
      createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }]);
    mockCreate.mockResolvedValue({
      metricId: 'deal-win-rate', title: 'Deal win rate', entityType: 'crm.deal',
      aggregate: 'count', system: false,
    });
    render(<MetricsPage />);
    await waitFor(() => expect(mockMetrics).toHaveBeenCalledWith('o1'));

    fillMetricForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save metric' })); });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0]).toBe('o1');
  });
});
