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
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledTimes(1));
    expect(resolveByRun).toHaveBeenCalledWith('r1', 'n1', { action: 'approve', comment: undefined });
    await waitFor(() => expect(common.onResolved).toHaveBeenCalled());
  });

  it('drops a same-tick double-click — resolves exactly once (CHAT-5)', async () => {
    // A pending (never-resolving) call keeps the first submit in flight so the
    // second synchronous click hits the guard, not the re-rendered disabled state.
    resolveByRun.mockReturnValue(new Promise(() => {}));
    render(<ApprovalCard {...common} data={{ prompt: 'Approve?', actions: ['approve'] }} />);
    const btn = screen.getByRole('button', { name: 'Approve' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledTimes(1));
  });

  it('ADR 0778 APUX-7 — a verb outside the known five still gets a name (was: t(undefined), WCAG 4.1.2)', () => {
    render(<ApprovalCard {...common} data={{ prompt: 'Approve?', actions: ['accept', 'send-back'] }} />);
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send back' })).toBeTruthy();
  });

  it('ADR 0778 APUX-5 — a 403 is the localized permission message, never the raw server text', async () => {
    resolveByRun.mockRejectedValue(Object.assign(new Error('forbidden_scope: Missing required scope: approvals:respond'), { status: 403 }));
    render(<ApprovalCard {...common} data={{ prompt: 'Approve?', actions: ['approve'] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/don't have permission to do that/i)).toBeTruthy();
    expect(screen.queryByText(/forbidden_scope/)).toBeNull();
  });

  it('ADR 0778 APUX-6 — two inline cards neither steal focus on mount nor trap Tab (WCAG 2.1.2)', () => {
    render(
      <div>
        <button type="button">before</button>
        <ApprovalCard {...common} nodeId="n1" data={{ prompt: 'A?', actions: ['approve'] }} />
        <ApprovalCard {...common} nodeId="n2" data={{ prompt: 'B?', actions: ['approve'] }} />
        <button type="button">after</button>
      </div>,
    );
    const before = screen.getByRole('button', { name: 'before' });
    expect(document.activeElement).not.toBe(screen.getAllByRole('textbox')[1]);
    // A trap listens for Tab in the capture phase and calls preventDefault.
    before.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented, 'an inline card captured Tab for the whole page').toBe(false);
  });
});
