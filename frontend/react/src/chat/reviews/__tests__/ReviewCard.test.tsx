import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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

  it('surfaces quorum progress as a labelled chip (ADR 0070)', () => {
    render(<ReviewCard review={{ ...base, policy: { requiredApprovals: 2, approvals: 1, rejections: 0 } }} onDecide={vi.fn()} />);
    expect(screen.getByText('1 of 2 approved')).toBeTruthy();
    expect(screen.getByLabelText('Quorum: 1 of 2 approved')).toBeTruthy();
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
