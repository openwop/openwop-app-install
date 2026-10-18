/**
 * CHAT-7 (salvaged from feat/cms-localization): behavior coverage for the
 * refinement interrupt form — a successful submit and JSON parsing — beyond the
 * existing a11y-label assertions.
 *
 * NOTE: the original CHAT-6 "blocks an empty/whitespace draft" test was dropped
 * during salvage — that guard behavior never landed on `main` (RefinementForm
 * submits whatever is in the draft), so the test asserted unimplemented
 * behavior. Re-add it only if/when the empty-draft guard is implemented.
 *
 * The form's whole job is to send the HUMAN's version: case 1 asserts the model
 * draft seeds the field, then edits it and asserts the edit — not the seed — is
 * what resolves the interrupt (w51 r2: a no-op `onChange` used to stay green).
 * Absorbs interruptForms' "draft field is label-associated and seeded" case.
 * APUX-10: a same-tick double submit resolves ONCE — both clicks fire inside one
 * `act`, so the disabled re-render cannot swallow the second and only the in-flight
 * ref can (w51 r2; probe rf-inflight was vacuous without it).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

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
    const draft = screen.getByLabelText<HTMLTextAreaElement>('Draft');
    expect(draft.tagName).toBe('TEXTAREA');
    expect(draft.value).toBe('a refined answer'); // the model's draft seeds the field
    fireEvent.change(draft, { target: { value: 'a human-edited answer' } });
    fireEvent.click(screen.getByRole('button', { name: /submit refinement/i }));
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledTimes(1));
    expect(resolveByRun).toHaveBeenCalledWith('r1', 'n1', { refinement: 'a human-edited answer' });
    await waitFor(() => expect(common.onResolved).toHaveBeenCalled());
  });

  it('drops a same-tick double submit — resolves exactly once (APUX-10)', async () => {
    resolveByRun.mockReturnValue(new Promise(() => {})); // keep the first submit in flight
    render(<RefinementForm {...common} data={{ current: 'x' }} />);
    const btn = screen.getByRole('button', { name: /submit refinement/i });
    act(() => { btn.click(); btn.click(); });
    await act(async () => {});
    expect(resolveByRun).toHaveBeenCalledTimes(1);
  });

  it('parses a JSON draft into structured refinement', async () => {
    render(<RefinementForm {...common} data={{ current: '{"k":1}' }} />);
    fireEvent.click(screen.getByRole('button', { name: /submit refinement/i }));
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('r1', 'n1', { refinement: { k: 1 } }));
  });
});
