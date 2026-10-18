/**
 * `SGU-2` / `SGU-3` — the strategy-activation group is a first-class citizen of the
 * shared approvals inbox.
 *
 * Both kinds sit in the SAME inbox with the same consequence shape (approve commits,
 * reject sends the subject back to draft). Content-publish got the reject-with-reason
 * bar — and with it the two focus behaviours earned through bugs — while strategy got
 * bare buttons and a kind-blind "Proposal dismissed." toast for an outcome that is
 * actually "back in draft, resubmittable".
 *
 * These legs pin the PARITY by BEHAVIOUR on both deciding surfaces: a strategy row
 * offers the reason step, the typed reason reaches `rejectApproval`, and the toast
 * says "back in draft … can be resubmitted".
 *
 * grade-tests w19 — the previous SGU-2 leg sliced `ApprovalsInbox.tsx` from the
 * strategy block to END OF FILE, so the Claude Code group's identical
 * `<ApprovalDecideBar … onReject={(note) => reject(a, note)}` satisfied it: bare
 * buttons in the strategy group stayed green (probe w19g5-pa-decidebar-strategy,
 * vacuous). Its export-name leg asserted what `tsc` already enforces (two inboxes
 * import the bar). The four-locale leg is `scripts/check-i18n.mjs`'s job (checks 1
 * and 4, in `npm run build`). Sabotage-witnessed: probes w19g5-pa-*.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PendingApproval } from '../../agents/approvalsClient.js';

const { listApprovals, listApprovalsByKind, rejectApproval } = vi.hoisted(() => ({
  listApprovals: vi.fn<() => Promise<PendingApproval[]>>(),
  listApprovalsByKind: vi.fn<() => Promise<PendingApproval[]>>(),
  rejectApproval: vi.fn<(id: string, note?: string) => Promise<void>>(),
}));
vi.mock('../../agents/approvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/approvalsClient.js')>()),
  listApprovals, listApprovalsByKind, rejectApproval,
}));
vi.mock('../../agents/agentViewModel.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/agentViewModel.js')>()),
  loadAgentViews: vi.fn(async () => []),
}));
vi.mock('../../orgs/orgMembers.js', () => ({ loadOrgMembers: vi.fn(async () => []), invalidateOrgMembers: vi.fn() }));
const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn<(m: string) => void>() }));
vi.mock('../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: toastInfo } }));

import { ApprovalsInbox } from '../ApprovalsInbox.js';
import { NeedsYouInbox } from '../NeedsYouInbox.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(here, '..', p), 'utf8');

const ROW: PendingApproval = {
  approvalId: 'sa1', rosterId: '', persona: '', workflowId: '',
  kind: 'strategy-activation', strategyId: 's1', strategyTitle: 'North Star', orgId: 'o1',
  proposal: 'Activate "North Star"?', status: 'pending', createdAt: '2026-08-20T00:00:00Z',
};

beforeEach(() => {
  listApprovals.mockReset(); listApprovalsByKind.mockReset(); rejectApproval.mockReset(); toastInfo.mockReset();
  listApprovals.mockResolvedValue([ROW]);
  listApprovalsByKind.mockResolvedValue([]);
  rejectApproval.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('SGU-2 / SGU-3 — a strategy activation is rejected WITH a reason, and the toast says back-in-draft', () => {
  for (const [name, Surface] of [['ApprovalsInbox', ApprovalsInbox], ['NeedsYouInbox', NeedsYouInbox]] as const) {
    it(`${name}: Reject opens the reason step, the note reaches the wire, and the toast says resubmittable`, async () => {
      render(<MemoryRouter><Surface /></MemoryRouter>);
      await screen.findByText('Activate "North Star"?');
      fireEvent.click(screen.getByRole('button', { name: /^reject$/i }));
      // The reasoned bar: a bare reject button has no reason step at all.
      const reason = await screen.findByLabelText(/why are you sending this back/i);
      fireEvent.change(reason, { target: { value: 'needs owners' } });
      fireEvent.click(screen.getByRole('button', { name: /send back to draft/i }));
      await waitFor(() => expect(rejectApproval).toHaveBeenCalledWith('sa1', 'needs owners'));
      await waitFor(() => expect(toastInfo).toHaveBeenCalledWith('Rejected — the strategy is back in draft and can be resubmitted.'));
    });
  }
});

describe('SGU-2 — the remaining bare-reject sites', () => {
  /**
   * RATCHET, shrink-only. Writing this test as "no group may use a bare reject" was the
   * first instinct and it FAILED — correctly. This inbox has five card groups
   * (content-publish, strategy-activation, scenario, spend, commerce-spend) plus a
   * DataTable branch, and only the first two now offer a reason. The other three belong
   * to other features and their reject semantics are not this iteration's to judge; the
   * table branch genuinely cannot host an expanding textarea inside a cell.
   *
   * So the honest assertion is a COUNT that may only fall: it records that the gap is
   * known and bounded, and a NEW group added with bare buttons pushes it up and reds.
   */
  it('RATCHET: the bare-reject sites are a known, shrink-only set (was 5 before this)', () => {
    const inbox = read('ApprovalsInbox.tsx');
    const bare = inbox.split('onClick={() => void reject(a)}').length - 1;
    expect(bare, 'a NEW approval group must not ship a reject that drops the reviewer note').toBeLessThanOrEqual(4);
  });
});
