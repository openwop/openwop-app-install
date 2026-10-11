/** ADR 0862 D3 — an approver cannot act while the action fields are suspended.
 * The namespace is deliberately held back: a fields-only Suspense boundary
 * would leave a working Approve button beside a calendar card missing its time
 * and guests. Release it and the same card becomes reviewable and actionable.
 *
 * Sabotage-witnessed (wave 11): wrap `<AssistantActionFields>` in its own
 * (fields-only) Suspense boundary in any of the three surfaces → that surface's
 * case red. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const gate = vi.hoisted(() => ({ blocked: false, attempts: 0, pending: Promise.resolve() }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: (ns?: string | string[], options?: { useSuspense?: boolean }) => {
      const result = actual.useTranslation(ns, options);
      if (gate.blocked && ns === 'assistantAction' && options?.useSuspense !== false) {
        gate.attempts += 1;
        throw gate.pending;
      }
      return result;
    },
  };
});

const calls = vi.hoisted(() => ({ list: vi.fn(), claim: vi.fn(), reject: vi.fn(), edit: vi.fn() }));
vi.mock('../../agents/approvalsClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agents/approvalsClient.js')>()),
  listApprovals: calls.list,
  listApprovalsByKind: vi.fn(async () => []),
  claimApproval: calls.claim,
  rejectApproval: calls.reject,
  editAssistantAction: calls.edit,
}));
vi.mock('../../agents/agentViewModel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agents/agentViewModel.js')>()),
  loadAgentViews: vi.fn(async () => []),
}));
vi.mock('../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../chat/reviews/ReviewHandoff.js', () => ({ ReviewHandoff: () => null }));

import { ApprovalsInbox } from '../ApprovalsInbox.js';
import { NeedsYouInbox } from '../NeedsYouInbox.js';
import { ReviewCard } from '../../chat/reviews/ReviewCard.js';
import type { ReviewRequest } from '../../chat/reviews/reviewClient.js';
import type { PendingApproval } from '../../agents/approvalsClient.js';

const action = {
  actionId: 'act:loading', kind: 'calendar.invite', draft: 'Invite Dana.',
  status: 'pending', contentHash: 'hash-reviewed',
  payload: { event: { summary: 'Q3 review', location: 'Room 4', attendees: [{ email: 'dana@example.com' }] } },
};
const approval = {
  approvalId: 'ap-loading', rosterId: 'r-assistant', persona: 'Iris', workflowId: '',
  kind: 'assistant-action', actionId: action.actionId, proposal: 'Invite Dana',
  status: 'pending', createdAt: '2026-10-07T00:00:00Z', action,
} satisfies PendingApproval;
const review: ReviewRequest = {
  reviewId: 'approval:ap-loading', source: 'approval', kind: 'assistant-action',
  status: 'pending', tenantId: 'default', requestedAt: '2026-10-07T00:00:00Z',
  requestedBy: { kind: 'agent', id: 'r-assistant', label: 'Iris' },
  summary: 'Invite Dana', actions: [{ action: 'approve' }, { action: 'reject' }], provenanceRefs: [],
  assistantAction: action,
};

afterEach(() => { gate.blocked = false; cleanup(); });
beforeEach(() => {
  vi.clearAllMocks();
  gate.attempts = 0;
  calls.list.mockResolvedValue([approval]);
  calls.claim.mockResolvedValue({});
});

describe('the whole assistant decision waits for its fields', () => {
  for (const surface of ['ApprovalsInbox', 'NeedsYouInbox', 'ReviewCard'] as const) {
    it(`${surface} offers no approve until the fields namespace is ready`, async () => {
      let release: () => void = () => undefined;
      gate.pending = new Promise<void>((resolve) => { release = resolve; });
      gate.blocked = true;
      const decide = vi.fn().mockResolvedValue(undefined);
      render(<MemoryRouter>{surface === 'ApprovalsInbox' ? <ApprovalsInbox />
        : surface === 'NeedsYouInbox' ? <NeedsYouInbox />
          : <ReviewCard review={review} onDecide={decide} />}</MemoryRouter>);

      await waitFor(() => expect(gate.attempts).toBeGreaterThan(0));
      expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull();
      expect(screen.queryByText('Room 4')).toBeNull();
      expect(calls.claim).not.toHaveBeenCalled();
      expect(decide).not.toHaveBeenCalled();

      await act(async () => { gate.blocked = false; release(); await gate.pending; });
      await screen.findByText('Room 4');
      fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
      if (surface === 'ReviewCard') {
        await waitFor(() => expect(decide).toHaveBeenCalledWith('approve', { expectedContentHash: action.contentHash }));
      } else {
        await waitFor(() => expect(calls.claim).toHaveBeenCalledWith(approval.approvalId, undefined, action.contentHash));
      }
    });
  }
});
