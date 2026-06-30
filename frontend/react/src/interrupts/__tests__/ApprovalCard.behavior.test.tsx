/**
 * CHAT-5: the ApprovalCard must not resolve an interrupt twice. The
 * `disabled={submitting}` button state relies on a re-render, so a same-tick
 * double-click could pass it twice; a synchronous in-flight ref closes that
 * window. These tests pin both the happy path and the double-submit guard.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const resolveByRun = vi.fn();
vi.mock('../../client/interruptsClient.js', () => ({
  resolveByRun: (...args: unknown[]) => resolveByRun(...args),
}));

import { ApprovalCard } from '../ApprovalCard.js';

const common = { runId: 'r1', nodeId: 'n1', token: 't', onResolved: vi.fn() };

beforeEach(() => {
  resolveByRun.mockReset();
  common.onResolved.mockReset();
});
afterEach(cleanup);

describe('ApprovalCard behavior', () => {
  it('resolves the interrupt once on approve', async () => {
    resolveByRun.mockResolvedValue(undefined);
    render(<ApprovalCard {...common} data={{ prompt: 'Approve?', actions: ['approve'] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'approve' }));
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledTimes(1));
    expect(resolveByRun).toHaveBeenCalledWith('r1', 'n1', { action: 'approve', comment: undefined });
    await waitFor(() => expect(common.onResolved).toHaveBeenCalled());
  });

  it('drops a same-tick double-click — resolves exactly once (CHAT-5)', async () => {
    // A pending (never-resolving) call keeps the first submit in flight so the
    // second synchronous click hits the guard, not the re-rendered disabled state.
    resolveByRun.mockReturnValue(new Promise(() => {}));
    render(<ApprovalCard {...common} data={{ prompt: 'Approve?', actions: ['approve'] }} />);
    const btn = screen.getByRole('button', { name: 'approve' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledTimes(1));
  });
});
