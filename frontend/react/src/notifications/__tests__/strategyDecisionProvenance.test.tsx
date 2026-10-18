/**
 * SGU-1 (ADR 0230 §B3, FEATURES.md ordinal 225) — on-screen provenance for the
 * strategy-activation approval gate. A consequential governance decision must
 * show WHO decided it and WHEN ("Approved by X on T" / "Rejected by X on T").
 *
 * Before this fix the inbox fetched only `listApprovals('pending')`, so a
 * resolved row vanished the moment it was decided and its `decidedBy` +
 * `resolvedAt` (already on the wire) were never read — zero on-screen
 * accountability for a gate that flips a strategy draft→active.
 *
 * The raw `decidedBy` is an opaque principal id; it MUST be name-resolved
 * (`loadOrgMembers` → displayName) and NEVER rendered as `user:<hash>`, and the
 * member's email MUST NOT leak onto the line (the RTCC-4 email-in-presence PII
 * lesson).
 *
 * Sabotage-witnessed (grade-tests w19, probes w19g5-dv-*): resolving to the
 * email, falling back to the raw principal, a kind-blind "Approved by" for a
 * rejection, an actor on a system-resolved row, an empty date, and letting the
 * empty-pending collapse swallow the decided group each turn a case red. The DATE
 * is asserted as the product's own `formatDateTime` of `resolvedAt` — before w19
 * every assertion stopped at "… on", so the WHEN half could vanish (w19g5-dv-date,
 * vacuous). The former "NO pending rows" case was byte-identical to the first
 * (every case here has an empty pending queue) and was cut in w19.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PendingApproval } from '../../agents/approvalsClient.js';
import type { OrgMember } from '../../client/accessClient.js';
import { formatDateTime } from '../../i18n/format.js';

const { listApprovals, listApprovalsByKind, claimApproval, rejectApproval } = vi.hoisted(() => ({
  listApprovals: vi.fn(), listApprovalsByKind: vi.fn(), claimApproval: vi.fn(), rejectApproval: vi.fn(),
}));
vi.mock('../../agents/approvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/approvalsClient.js')>()),
  listApprovals, listApprovalsByKind, claimApproval, rejectApproval,
}));
vi.mock('../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const { loadOrgMembers } = vi.hoisted(() => ({ loadOrgMembers: vi.fn() }));
vi.mock('../../orgs/orgMembers.js', () => ({ loadOrgMembers, invalidateOrgMembers: vi.fn() }));

import { ApprovalsInbox } from '../ApprovalsInbox.js';

const RESOLVED_APPROVED: PendingApproval = {
  approvalId: 'sa1', rosterId: 'r', persona: 'System', workflowId: '',
  kind: 'strategy-activation', strategyId: 's1', orgId: 'org1',
  proposal: 'Activate "North Star 2027"?', status: 'approved',
  createdAt: '2026-08-20T00:00:00Z', resolvedAt: '2026-08-21T15:30:00Z',
  decidedBy: 'user:abc123hash',
};
const WHEN = formatDateTime('2026-08-21T15:30:00Z');
const MEMBER: OrgMember = {
  memberId: 'm1', orgId: 'org1', tenantId: 't', subject: 'user:abc123hash',
  displayName: 'Dana Ops', email: 'dana@example.co', roles: [], teamIds: [],
  createdAt: '', updatedAt: '',
};
// The pending queue is empty; the bounded decided-history read returns the rows.
const withRows = (rows: PendingApproval[]): void => {
  listApprovals.mockResolvedValue([]); // listApprovals('pending')
  listApprovalsByKind.mockResolvedValue(rows); // listApprovalsByKind('strategy-activation', …)
};

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });

describe('SGU-1 — strategy-activation decision provenance (approver + timestamp)', () => {
  it('shows "Approved by <name> on <date>" for a resolved row, name-resolved from the raw principal', async () => {
    withRows([RESOLVED_APPROVED]);
    loadOrgMembers.mockResolvedValue([MEMBER]);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    // The pending queue is EMPTY in every case here, so this also pins that the
    // collapsed "nothing awaiting sign-off" line does not swallow the decided group.
    await screen.findByText(`Approved by Dana Ops on ${WHEN}`);
    expect(screen.queryByText(/abc123hash/)).toBeNull();        // no raw user:<hash>
    expect(screen.queryByText(/dana@example\.co/)).toBeNull();  // no email leak (RTCC-4)
  });

  it('shows "Rejected by <name> on <date>" for a rejected decision', async () => {
    withRows([{ ...RESOLVED_APPROVED, approvalId: 'sa2', status: 'rejected' }]);
    loadOrgMembers.mockResolvedValue([MEMBER]);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    await screen.findByText(`Rejected by Dana Ops on ${WHEN}`);
  });

  it('falls back to a neutral label (never the raw hash) when the principal cannot be resolved', async () => {
    withRows([RESOLVED_APPROVED]);
    loadOrgMembers.mockResolvedValue([]); // no member matches the subject
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    await screen.findByText(`Approved by a workspace member on ${WHEN}`);
    expect(screen.queryByText(/abc123hash/)).toBeNull();
  });

  it('shows "Approved on <date>" with no name when the decision has no recorded decider (system-resolved)', async () => {
    const { decidedBy: _omit, ...systemResolved } = RESOLVED_APPROVED;
    withRows([systemResolved]);
    loadOrgMembers.mockResolvedValue([]);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    await screen.findByText(`Approved on ${WHEN}`);
  });
});
