import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ReviewCard } from '../ReviewCard.js';
import type { ReviewRequest } from '../reviewClient.js';

afterEach(cleanup);

/**
 * ReviewCard (ADR 0068) — proves the normalized card derives its actions from
 * the backend record (never client-guessed), dispatches the chosen action, and
 * renders read-only when the source reports no available actions (resolved).
 */
const base: ReviewRequest = {
  reviewId: 'approval:appr-1',
  source: 'approval',
  kind: 'run-proposal',
  status: 'pending',
  tenantId: 't1',
  requestedBy: { kind: 'agent', id: 'roster:scout', label: 'Scout' },
  requestedAt: '2026-06-18T00:00:00Z',
  summary: 'Run intake on the Garcia card',
  actions: [{ action: 'approve', label: 'Approve & run' }, { action: 'reject', label: 'Reject' }],
  provenanceRefs: [{ kind: 'card', ref: 'card-1', label: 'New family: Garcia' }],
};

describe('ReviewCard', () => {
  it('renders the summary, source-derived actions, and provenance', () => {
    render(<ReviewCard review={base} onDecide={vi.fn()} />);
    expect(screen.getByText('Run intake on the Garcia card')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Approve & run/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reject/ })).toBeTruthy();
    expect(screen.getByText('New family: Garcia')).toBeTruthy();
  });

  it('dispatches the chosen action (with the note) to onDecide', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ReviewCard review={base} onDecide={onDecide} />);
    fireEvent.change(screen.getByPlaceholderText(/Add a note/), { target: { value: 'looks good' } });
    fireEvent.click(screen.getByRole('button', { name: /Approve & run/ }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approve', { note: 'looks good' }));
  });

  // PRE-1 — this asserted `getByLabelText('Quorum: 1 of 2 approved')`, a container
  // aria-label that #2778 DELIBERATELY removed: on a role-less div it was prohibited
  // and ignored outright (axe `aria-prohibited-attr`), and it duplicated the chip
  // text. The component change was right; the test was not updated with it, so main
  // went red at that merge. Re-pointed at what AT actually announces now — and
  // extended to PIN the decision, so a future "fix" cannot quietly restore the
  // redundant label.
  it('surfaces quorum progress as chip TEXT, not a duplicate container label (ADR 0070 / #2778)', () => {
    const { container } = render(
      <ReviewCard review={{ ...base, policy: { requiredApprovals: 2, approvals: 1, rejections: 1 } }} onDecide={vi.fn()} />,
    );
    // What a screen reader reads: the chips themselves.
    expect(screen.getByText('1 of 2 approved')).toBeTruthy();
    expect(screen.getByText('1 rejected')).toBeTruthy();

    const quorum = container.querySelector('.review-card__quorum');
    expect(quorum, 'fixture guard: the quorum block must render or nothing below is checked').toBeTruthy();

    // The block must NOT carry a name that duplicates the chips — that is the
    // regression #2778 fixed, and re-adding it would make AT announce the summary
    // INSTEAD of the chips.
    expect(quorum!.getAttribute('aria-label'), 'the container label was removed on purpose').toBeNull();

    // The meter is decorative and must stay hidden, or it doubles the announcement.
    const meter = container.querySelector('.review-card__quorum-meter');
    expect(meter?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders read-only (no action buttons) once the source reports no actions', () => {
    render(<ReviewCard review={{ ...base, status: 'approved', actions: [] }} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reject/ })).toBeNull();
  });

  it('sends an empty value object for a requiresValue (interrupt) action', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const interruptReview: ReviewRequest = {
      ...base, reviewId: 'interrupt:i1', source: 'interrupt', kind: 'clarification',
      actions: [{ action: 'resolve', label: 'Submit', requiresValue: true }], provenanceRefs: [],
    };
    render(<ReviewCard review={interruptReview} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('resolve', { value: {} }));
  });
});

/**
 * ADR 0473 Phase 2 — the composed-workflow proposal section: payload-level
 * preview (steps + role badges), approve-what-you-see (the approve echoes the
 * LIVE hash the card displayed), staleness/expiry notices, builder deep-link.
 */
const composed: ReviewRequest = {
  ...base,
  reviewId: 'approval:appr-cw',
  kind: 'composed-workflow',
  workflowId: 'agent-wf-1',
  workflowName: 'agent-wf-1',
  summary: 'Summarize new leads each morning',
  actions: [{ action: 'approve', label: 'Approve & run' }, { action: 'reject', label: 'Reject' }],
  provenanceRefs: [],
  composedWorkflow: {
    definitionHash: 'pin-1',
    liveDefinitionHash: 'live-2',
    editedSinceProposed: true,
    agentProfileId: 'feature.workflow-author.agents.workflow-architect',
    nodeCount: 3,
    edgeCount: 2,
    expiresAt: '2099-01-01T00:00:00Z',
    runInputs: { segment: 'new-leads' },
    steps: [
      { nodeId: 'a', typeId: 'feature.crm.nodes.search', role: 'read' },
      { nodeId: 'b', typeId: 'vendor.openwop-app.chat-responder', role: 'unclassified' },
    ],
  },
};

describe('ReviewCard composed-workflow section (ADR 0473)', () => {
  it('renders steps with role badges, the evidence line, and the builder deep-link', async () => {
    render(<MemoryRouter><ReviewCard review={composed} onDecide={vi.fn()} /></MemoryRouter>);
    // The section is lazy-loaded (entry-budget split) — await its first paint.
    expect(await screen.findByText('feature.crm.nodes.search')).toBeTruthy();
    expect(screen.getByText('read')).toBeTruthy();
    expect(screen.getByText('unclassified')).toBeTruthy();
    expect(screen.getByText(/3 nodes/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Open in builder/ });
    expect(link.getAttribute('href')).toBe('/builder/agent-wf-1');
  });

  it('shows the edited-since-proposed notice and approves with the LIVE hash (approve-what-you-see)', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<MemoryRouter><ReviewCard review={composed} onDecide={onDecide} /></MemoryRouter>);
    expect(await screen.findByText(/Edited since proposed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Approve & run/ }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approve', { expectedDefinitionHash: 'live-2' }));
  });

  it('reject does NOT carry the hash (only approve pins what was seen)', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<MemoryRouter><ReviewCard review={composed} onDecide={onDecide} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/ }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('reject', {}));
  });

  it('renders the expired notice and the frozen run inputs', async () => {
    const expired = { ...composed, composedWorkflow: { ...composed.composedWorkflow!, expired: true } };
    render(<MemoryRouter><ReviewCard review={expired} onDecide={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByText(/Expired — ask the agent/)).toBeTruthy();
    expect(screen.getByText('Run inputs')).toBeTruthy();
  });

  it('shows the reviewer note on a resolved card', () => {
    const resolved: ReviewRequest = { ...composed, status: 'rejected', actions: [], decisionNote: 'use the CRM chain instead' };
    render(<MemoryRouter><ReviewCard review={resolved} onDecide={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText('use the CRM chain instead')).toBeTruthy();
  });
});
