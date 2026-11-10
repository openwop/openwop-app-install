/**
 * ADR 1001 D8 — an agent's multi-question clarification on the run page / inbox.
 *
 * Why it exists: the card is where a model-authored ask meets a person. It must
 * (1) send exactly the `ClarificationResume` the host's generated resumeSchema
 * accepts — every question, in order, ids intact — and nothing until all are
 * answered; (2) offer an explicit Skip that sends the spec's empty
 * `ClarificationResume` (`{answers: []}`, the same value the host's expiry
 * sends); only for the host's agent ask (`profile`); (3) render model text as TEXT, so markup in a choice is never
 * live; (4) fall back to the legacy single-question card for anything the model
 * parser does not recognise. Each case was sabotage-witnessed red.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';

const resolveByRun = vi.fn();
vi.mock('../../client/interruptsClient.js', () => ({
  resolveByRun: (...args: unknown[]) => resolveByRun(...args),
}));

import { ClarificationDialog } from '../ClarificationDialog.js';
import { parseAgentClarification } from '../clarificationModel.js';

const common = { runId: 'r1', nodeId: 'n1', token: 't', onResolved: vi.fn() };
const data = {
  profile: 'openwop-agent-clarification',
  askedBy: 'Iris',
  questions: [
    { id: 'region', question: 'Which region?', schema: { type: 'string', enum: ['EMEA', '<img src=x onerror=alert(1)>'] } },
    { id: 'confirm', question: 'Send now?', schema: { type: 'boolean' } },
    { id: 'note', question: 'Anything else?', schema: { type: 'string', minLength: 1, maxLength: 2000 } },
  ],
};

beforeEach(() => {
  resolveByRun.mockReset();
  resolveByRun.mockResolvedValue(undefined);
  common.onResolved.mockReset();
});
afterEach(cleanup);

describe('ClarificationDialog — agent ask (ADR 1001 D8)', () => {
  it('sends every answer in question order, and only once all are answered', async () => {
    render(<ClarificationDialog {...common} data={data} />);
    expect(screen.getByRole('heading', { name: 'Iris needs an answer' })).toBeTruthy();
    const submit = screen.getByRole('button', { name: /submit answer/i });
    fireEvent.click(screen.getByRole('radio', { name: 'EMEA' }));
    fireEvent.click(screen.getByRole('radio', { name: 'No' }));
    expect((submit as HTMLButtonElement).disabled).toBe(true); // the free-text answer is still empty
    // The question names its group; the field keeps the short caption.
    fireEvent.change(within(screen.getByRole('group', { name: 'Anything else?' })).getByLabelText('Your answer'), { target: { value: 'ship it' } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledTimes(1));
    expect(resolveByRun).toHaveBeenCalledWith('r1', 'n1', {
      answers: [{ id: 'region', answer: 'EMEA' }, { id: 'confirm', answer: false }, { id: 'note', answer: 'ship it' }],
    });
  });

  it('skips with the spec\'s empty ClarificationResume, { answers: [] }', async () => {
    render(<ClarificationDialog {...common} data={data} />);
    fireEvent.click(screen.getByRole('button', { name: /skip, continue without/i }));
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('r1', 'n1', { answers: [] }));
  });

  it('renders a choice carrying markup as plain text, never as an element', () => {
    const { container } = render(<ClarificationDialog {...common} data={data} />);
    expect(screen.getByRole('radio', { name: '<img src=x onerror=alert(1)>' })).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('drops a same-tick double submit (APUX-10)', async () => {
    resolveByRun.mockReturnValue(new Promise(() => {}));
    render(<ClarificationDialog {...common} data={data} />);
    const skip = screen.getByRole('button', { name: /skip, continue without/i });
    act(() => { skip.click(); skip.click(); });
    await act(async () => {});
    expect(resolveByRun).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy single-question card for the core.clarificationGate shape', async () => {
    render(<ClarificationDialog {...common} data={{ question: 'Which file?', schema: { type: 'string' } }} />);
    expect(screen.getByText('Which file?')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'a.txt' } });
    fireEvent.click(screen.getByRole('button', { name: /submit answer/i }));
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('r1', 'n1', { answer: 'a.txt' }));
  });
});

describe('parseAgentClarification fails closed (ADR 1001 D8)', () => {
  it('refuses an out-of-vocabulary schema, too many questions or choices, and duplicate ids', () => {
    const P = { profile: 'openwop-agent-clarification' };
    const q = (schema: unknown) => ({ ...P, questions: [{ id: 'q', question: 'x?', schema }] });
    expect(parseAgentClarification(q({ type: 'string', pattern: 'a' }))).not.toBeNull(); // pattern ignored, host already refused it
    expect(parseAgentClarification(q({ type: 'object' }))).toBeNull();
    // The caps hold at the boundary: 8 choices and 5 questions are the legal maximum; one more is refused.
    expect(parseAgentClarification(q({ type: 'string', enum: Array.from({ length: 8 }, (_, i) => `c${i}`) }))).not.toBeNull();
    expect(parseAgentClarification(q({ type: 'string', enum: Array.from({ length: 9 }, (_, i) => `c${i}`) }))).toBeNull();
    expect(parseAgentClarification({ ...P, questions: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, question: 'x?' })) })).not.toBeNull();
    expect(parseAgentClarification({ ...P, questions: Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, question: 'x?' })) })).toBeNull();
    expect(parseAgentClarification({ ...P, questions: [{ id: 'q', question: 'a?' }, { id: 'q', question: 'b?' }] })).toBeNull();
    // Another producer's questions[] clarification has its own resume shape.
    expect(parseAgentClarification({ questions: [{ id: 'q', question: 'x?' }] })).toBeNull();
    expect(parseAgentClarification({ question: 'legacy' })).toBeNull();
  });
});
