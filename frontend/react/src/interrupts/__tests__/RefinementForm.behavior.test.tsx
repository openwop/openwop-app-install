/**
 * CHAT-7 (salvaged from feat/cms-localization): behavior coverage for the
 * refinement interrupt form — a successful submit and JSON parsing — beyond the
 * existing a11y-label assertions.
 *
 * NOTE: the original CHAT-6 "blocks an empty/whitespace draft" test was dropped
 * during salvage — that guard behavior never landed on `main` (RefinementForm
 * submits whatever is in the draft), so the test asserted unimplemented
 * behavior. Re-add it only if/when the empty-draft guard is implemented.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const resolveByRun = vi.fn();
vi.mock('../../client/interruptsClient.js', () => ({
  resolveByRun: (...args: unknown[]) => resolveByRun(...args),
}));

import { RefinementForm } from '../RefinementForm.js';

const common = { runId: 'r1', nodeId: 'n1', token: 't', onResolved: vi.fn() };

beforeEach(() => {
  resolveByRun.mockReset();
  resolveByRun.mockResolvedValue(undefined);
  common.onResolved.mockReset();
});
afterEach(cleanup);

describe('RefinementForm behavior', () => {
  it('submits a non-empty draft and resolves the interrupt', async () => {
    render(<RefinementForm {...common} data={{ current: 'a refined answer' }} />);
    fireEvent.click(screen.getByRole('button', { name: /submit refinement/i }));
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledTimes(1));
    expect(resolveByRun).toHaveBeenCalledWith('r1', 'n1', { refinement: 'a refined answer' });
    await waitFor(() => expect(common.onResolved).toHaveBeenCalled());
  });

  it('parses a JSON draft into structured refinement', async () => {
    render(<RefinementForm {...common} data={{ current: '{"k":1}' }} />);
    fireEvent.click(screen.getByRole('button', { name: /submit refinement/i }));
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('r1', 'n1', { refinement: { k: 1 } }));
  });
});
