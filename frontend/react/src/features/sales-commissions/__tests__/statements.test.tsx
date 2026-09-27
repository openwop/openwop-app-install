/**
 * UX_UPGRADE-sales-commissions — COM2-G1 / COM2-G2 / COM2-G3.
 *
 *  - COM2-G1: a failed statements read caught into `[]`, which on a COMMISSION
 *    surface renders as "no statements" — i.e. "nobody is owed anything". That
 *    is the most consequential thing this page can say, and it said it whenever
 *    the read merely failed.
 *  - COM2-G2: "mark paid" SETTLES the record — the row becomes terminal with no
 *    un-pay action anywhere in this UI — and it fired straight from the click.
 *  - COM2-G3: the compute form picks a rep BY NAME via the shared UserPicker
 *    ("instead of a raw subject id", per its own comment) and the table beneath
 *    it printed the raw subject id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import type { CommissionStatement, CommissionPlan } from '../commissionsClient.js';

const listPlans = vi.fn();
const listStatements = vi.fn();
const payStatement = vi.fn();
const approveStatement = vi.fn();
const loadOrgMembers = vi.fn();
const confirmMock = vi.fn();

vi.mock('../commissionsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listPlans: () => listPlans(),
  listStatements: () => listStatements(),
  payStatement: (...a: unknown[]) => payStatement(...a),
  approveStatement: (...a: unknown[]) => approveStatement(...a),
  computeStatement: vi.fn(async () => ({ total: 1, currency: 'USD' })),
}));
// Spread the real module — `UserPicker` imports from it too, and enumerating
// the exports left it with undefined helpers (the same partial-mock trap this
// programme hit on commerce/OrderDetailPage).
vi.mock('../../../orgs/orgMembers.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadOrgMembers: () => loadOrgMembers(),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: (o: unknown) => confirmMock(o) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { CommissionsPage } from '../CommissionsPage.js';

// Complete fixture, no cast — `updatedAt` is required and `orgId` is not a field.
const PLAN: CommissionPlan = {
  planId: 'pl-1', name: 'Standard', currency: 'USD', rules: [],
  assignment: { kind: 'rep', ref: 'user:rep-a' },
  effectiveFrom: '2026-01-01', updatedAt: '2026-07-01T00:00:00.000Z',
};

const stmt = (over: Partial<CommissionStatement> = {}): CommissionStatement => ({
  statementId: 'st-1', orgId: 'org-1', planId: 'pl-1', subjectId: 'user:rep-a',
  period: '2026-Q1', total: 4200, currency: 'USD', status: 'approved',
  ...over,
} as CommissionStatement);

const view = async (): Promise<void> => {
  render(<CommissionsPage />);
  await act(async () => {});
  await waitFor(() => expect(listStatements).toHaveBeenCalled());
};

beforeEach(() => {
  for (const m of [listPlans, listStatements, payStatement, approveStatement, loadOrgMembers, confirmMock]) m.mockReset();
  listPlans.mockResolvedValue([PLAN]);
  listStatements.mockResolvedValue([stmt()]);
  loadOrgMembers.mockResolvedValue([{ memberId: 'm1', orgId: 'org-1', tenantId: 't', subject: 'user:rep-a', displayName: 'Ada Rep', roles: [] }]);
  payStatement.mockResolvedValue({});
  confirmMock.mockResolvedValue(true);
});
afterEach(cleanup);

describe('COM2-G1: a failed statements read is not "nobody is owed anything"', () => {
  it('says the list could not be loaded, and says what it does NOT mean', async () => {
    listStatements.mockRejectedValue(new Error('statements store down'));
    await view();
    const notice = await screen.findByText(/statements could not be loaded/i);
    // The clarifying half matters more than the error itself on a pay surface.
    expect(notice.textContent ?? '').toMatch(/does not mean nothing is owed/i);
  });

  it('a genuinely empty list says nothing about a failure', async () => {
    listStatements.mockResolvedValue([]);
    await view();
    // POSITIVE ANCHOR first. Absence-only, this arm would have passed against a
    // tree that rendered nothing at all — the failure copy is missing there too,
    // so it could not tell "the empty state is intact" from "the list never
    // rendered". `noStatementsTitle` (CommissionsPage.tsx:361) is the designed
    // empty state, and it is on the SAME branch the failure notice would preempt.
    expect(await screen.findByText(/No statements yet/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});

describe('COM2-G2: marking a commission paid is confirmed', () => {
  it('confirms, naming the amount and the rep', async () => {
    await view();
    fireEvent.click(await screen.findByRole('button', { name: /mark paid/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    // `mock.calls[0]` is possibly-undefined under exactOptionalPropertyTypes; assert
// the call happened (the waitFor above already proves it) rather than casting.
    const firstCall = confirmMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const opts = firstCall![0] as { title: string; body: string; danger?: boolean };
    expect(opts.danger).toBe(true);
    expect(opts.title).toMatch(/Ada Rep/);
    expect(opts.title).toMatch(/\$4,200/);
    expect(opts.body).toMatch(/no way to reverse it/i);
  });

  it('declining does NOT settle the statement', async () => {
    confirmMock.mockResolvedValue(false);
    await view();
    fireEvent.click(await screen.findByRole('button', { name: /mark paid/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(payStatement).not.toHaveBeenCalled();
  });

  it('submitting for review is NOT gated — it is reversible by the reviewer', async () => {
    listStatements.mockResolvedValue([stmt({ status: 'draft' })]);
    await view();
    fireEvent.click(await screen.findByRole('button', { name: /submit/i }));
    await waitFor(() => expect(approveStatement).toHaveBeenCalled());
    // A gate on every step is a gate nobody reads.
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe('COM2-G3: the table names the rep', () => {
  it('resolves the subject id to a display name', async () => {
    await view();
    // Scoped to the TABLE: the picker now shares the same members fetch, so it
    // also shows "Ada Rep" — an unscoped query matches both, which is a happy
    // consequence of reusing one resolver rather than an ambiguity in the fix.
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Ada Rep')).toBeTruthy();
    expect(within(table).queryByText('user:rep-a')).toBeNull();
  });

  it('falls back to the id when the member is unknown', async () => {
    loadOrgMembers.mockResolvedValue([]);
    await view();
    // Never a blank cell — the id is the only handle left.
    const table = await screen.findByRole('table');
    expect(within(table).getByText('user:rep-a')).toBeTruthy();
  });
});
