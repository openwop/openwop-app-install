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
 *
 * Sabotage-witnessed (w52 round 2, `w52g2-cm-*-r2`): the catch reporting success
 * (no notice), Retry wired to a no-op (no table after Retry), the pay gate removed
 * or `!ok` ignored, `payStatement` replaced by a resolved no-op (no settle call),
 * `danger:false`, the confirm naming the raw id, submit-for-review gated, and the
 * table printing the raw id / a blank cell. Money is `4200.5` so a formatter that
 * drops cents changes the asserted title.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import type { CommissionStatement, CommissionPlan } from '../commissionsClient.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

type CommApi = typeof import('../commissionsClient.js');
type MembersApi = typeof import('../../../orgs/orgMembers.js');
type ConfirmApi = typeof import('../../../ui/confirm.js');

const listPlans = vi.fn<CommApi['listPlans']>();
const listStatements = vi.fn<CommApi['listStatements']>();
const payStatement = vi.fn<CommApi['payStatement']>();
const approveStatement = vi.fn<CommApi['approveStatement']>();
const loadOrgMembers = vi.fn<MembersApi['loadOrgMembers']>();
const confirmMock = vi.fn<ConfirmApi['confirm']>();

vi.mock('../commissionsClient.js', async (orig) => ({
  ...(await orig<CommApi>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listPlans: (orgId: string) => listPlans(orgId),
  listStatements: (orgId: string) => listStatements(orgId),
  payStatement: (orgId: string, id: string) => payStatement(orgId, id),
  approveStatement: (orgId: string, id: string) => approveStatement(orgId, id),
}));
// Spread the real module — `UserPicker` imports from it too, and enumerating
// the exports left it with undefined helpers (the same partial-mock trap this
// programme hit on commerce/OrderDetailPage).
vi.mock('../../../orgs/orgMembers.js', async (orig) => ({
  ...(await orig<MembersApi>()),
  loadOrgMembers: (orgId?: string) => loadOrgMembers(orgId),
}));
vi.mock('../../../ui/confirm.js', async (orig) => ({
  ...(await orig<ConfirmApi>()),
  confirm: (o: Parameters<ConfirmApi['confirm']>[0]) => confirmMock(o),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess(),
}));

import { CommissionsPage } from '../CommissionsPage.js';

// Complete fixture, no cast — `updatedAt` is required and `orgId` is not a field.
const PLAN: CommissionPlan = {
  planId: 'pl-1', name: 'Standard', currency: 'USD', rules: [],
  assignment: { kind: 'rep', ref: 'user:rep-a' },
  effectiveFrom: '2026-01-01', updatedAt: '2026-07-01T00:00:00.000Z',
};

// Typed, no cast: `orgId` is not a field; `lines` + `updatedAt` are required.
// `4200.5` (not a whole number) so a formatter that drops cents changes the title.
const stmt = (over: Partial<CommissionStatement> = {}): CommissionStatement => ({
  statementId: 'st-1', planId: 'pl-1', subjectId: 'user:rep-a',
  period: '2026-Q1', lines: [], total: 4200.5, currency: 'USD', status: 'approved',
  updatedAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

const view = async (): Promise<void> => {
  render(<CommissionsPage />);
  await act(async () => {});
  await waitFor(() => expect(listStatements).toHaveBeenCalled());
};

beforeEach(() => {
  for (const m of [listPlans, listStatements, payStatement, approveStatement, loadOrgMembers, confirmMock]) m.mockReset();
  listPlans.mockResolvedValue([PLAN]);
  listStatements.mockResolvedValue([stmt()]);
  loadOrgMembers.mockResolvedValue([{ memberId: 'm1', orgId: 'org-1', tenantId: 't', subject: 'user:rep-a', displayName: 'Ada Rep', roles: [], teamIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]);
  payStatement.mockResolvedValue(stmt({ status: 'paid' }));
  approveStatement.mockResolvedValue({ review: { approvalId: 'ap-1', status: 'pending' } });
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

  // COM-EMPTY-ON-FAIL-1 — the catch above the notice still wrote `[]`, so the
  // page said BOTH "could not be loaded" and, under it, "No statements yet":
  // the second sentence is the "nobody is owed anything" claim COM2-G1 exists
  // to prevent. DOUBLE GUARD: the catch leaves the list unset AND StatementsPanel
  // renders no list while failed; either one alone keeps this green (probed).
  // Sabotage both — restore `setStatements([])` in the catch and drop the
  // `statementsFailed ? null :` guard — → red.
  it('a failed read shows no empty state, and Retry re-reads into the real list (COM-EMPTY-ON-FAIL-1)', async () => {
    listStatements.mockRejectedValueOnce(new Error('statements store down'));
    await view();
    const notice = await screen.findByText(/statements could not be loaded/i);
    expect(screen.queryByText(/No statements yet/i)).toBeNull();

    listStatements.mockResolvedValueOnce([stmt()]);
    fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Ada Rep')).toBeTruthy();
    expect(screen.queryByText(/statements could not be loaded/i)).toBeNull();
    expect(listStatements).toHaveBeenCalledTimes(2);
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
    const opts = confirmMock.mock.calls[0]?.[0];
    expect(opts?.danger).toBe(true);
    // Exact copy: the amount keeps its cents (COM2-M1) and the rep is named.
    expect(opts?.title).toBe('Mark $4,200.50 paid to Ada Rep?');
    expect(opts?.body).toBe('This settles the statement. There is no way to reverse it from this page.');
    // An ACCEPTED confirm settles exactly this statement, in this org.
    await waitFor(() => expect(payStatement).toHaveBeenCalledWith('org-1', 'st-1'));
    expect(payStatement).toHaveBeenCalledTimes(1);
  });

  it('declining does NOT settle the statement', async () => {
    confirmMock.mockResolvedValue(false);
    await view();
    fireEvent.click(await screen.findByRole('button', { name: /mark paid/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    // Settle the awaited confirm before asserting the absence (the pay call would
    // follow it in the same microtask chain).
    await act(async () => {});
    expect(payStatement).not.toHaveBeenCalled();
  });

  it('submitting for review is NOT gated — it is reversible by the reviewer', async () => {
    listStatements.mockResolvedValue([stmt({ status: 'draft' })]);
    await view();
    fireEvent.click(await screen.findByRole('button', { name: /submit/i }));
    await waitFor(() => expect(approveStatement).toHaveBeenCalledWith('org-1', 'st-1'));
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
