/**
 * ADR 0524 Phase E — preset inputs are editable, and a CLEAR stays cleared.
 *
 * This is the surface the whole ADR 0523/0524 program was clearing the way for.
 * Every earlier phase existed to make one gesture safe: **a user removing a
 * preset input and it staying removed.** Before E0 and the revision stamp, that
 * gesture was indistinguishable from an old bundle stripping the field, so the
 * server would have restored it and a later repair could have restored it again.
 *
 * The two assertions that matter are therefore:
 *   1. clearing the LAST input empties the set (the whole-set discriminator's
 *      one real false positive — the case ADR 0524 §Open named as the reason
 *      editable inputs were blocked);
 *   2. a structural value (an RFC 0124 variable ref) is NOT text-editable,
 *      because retyping `{{topic}}` would turn a live reference into a literal.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Inspector } from '../Inspector.js';
import { useBuilderStore } from '../../store/builderStore.js';

/**
 * Seed one selected node carrying `inputs`, THROUGH THE STORE'S OWN API.
 *
 * Hand-writing `setState` with a node literal was the first cut, and it rendered
 * nothing: the Inspector resolves a catalog entry by `typeId`, so a fabricated
 * node with an unknown type short-circuits before the preset section. The
 * fixture guard below caught it — a test that seeds state the product cannot
 * produce measures nothing about the product.
 */
function seed(inputs: Record<string, unknown>) {
  const id = useBuilderStore.getState().addNode('noop', { x: 0, y: 0 });
  useBuilderStore.getState().updateNode(id, { inputs });
  useBuilderStore.getState().selectNode(id);
  return id;
}

const inputsOf = () =>
  (useBuilderStore.getState().nodes[0] as unknown as { inputs?: Record<string, unknown> }).inputs;

describe('preset inputs — editable (ADR 0524 Phase E)', () => {
  afterEach(cleanup);
  beforeEach(() => {
    const st = useBuilderStore.getState();
    for (const n of [...st.nodes]) st.removeNode(n.id);
    st.selectNode(null);
  });

  it('fixture guard: the section renders a control for a plain string value', () => {
    // Without this, every assertion below could be querying a section that
    // never rendered, and would pass by finding nothing to contradict it.
    seed({ to: 'someone@example.com' });
    render(<Inspector />);
    expect(screen.getByDisplayValue('someone@example.com')).toBeTruthy();
  });

  it('editing a plain string writes it back as a plain string', () => {
    seed({ to: 'old@example.com' });
    render(<Inspector />);
    fireEvent.change(screen.getByDisplayValue('old@example.com'), {
      target: { value: 'new@example.com' },
    });
    expect(inputsOf()?.to).toBe('new@example.com');
  });

  it('editing a {type:static} envelope KEEPS the envelope', () => {
    // Flattening it to a bare string would be a silent format change on a value
    // the executor reads structurally.
    seed({ prompt: { type: 'static', value: 'before' } });
    render(<Inspector />);
    fireEvent.change(screen.getByDisplayValue('before'), { target: { value: 'after' } });
    expect(inputsOf()?.prompt).toEqual({ type: 'static', value: 'after' });
  });

  it('THE LOAD-BEARING ONE: clearing the LAST input leaves the set EMPTY', () => {
    // ADR 0524 §Open named exactly this as the reason editable inputs were
    // blocked: a workflow with one input-carrying node whose input is cleared
    // IS a whole-set omission, and the server guard would have resurrected it.
    // E0's declaration is what makes the server treat this as a deletion.
    seed({ to: 'someone@example.com' });
    render(<Inspector />);
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(inputsOf(), 'the cleared input came back').toEqual({});
  });

  it('clearing ONE of several leaves the others untouched', () => {
    seed({ to: 'a@example.com', subject: 'hello' });
    render(<Inspector />);
    const clears = screen.getAllByRole('button', { name: /clear/i });
    fireEvent.click(clears[0]!);
    expect(inputsOf()).toEqual({ subject: 'hello' });
  });

  it('a VARIABLE REF is not text-editable — retyping it would delete the reference', () => {
    // `{{topic}}` is a rendering of a structure, not the value. A text box over
    // it invites the user to turn a live RFC 0124 reference into a literal.
    seed({ topic: { type: 'variable', variableName: 'topic' } });
    render(<Inspector />);
    expect(screen.queryByDisplayValue('{{topic}}'), 'a structural ref was offered as text').toBeNull();
    expect(screen.getByText(/\{\{topic\}\}/)).toBeTruthy();
  });

  it('a non-editable value SAYS why, rather than silently offering no control', () => {
    seed({ topic: { type: 'variable', variableName: 'topic' } });
    render(<Inspector />);
    expect(screen.getByText(/edit it where it is defined/i)).toBeTruthy();
  });

  it('the value field has an accessible name — the <dt> beside it is not one', () => {
    // A text box whose only visible label is a sibling <dt> has no accessible
    // name at all; the label is present but visually hidden.
    seed({ to: 'a@example.com' });
    render(<Inspector />);
    expect(screen.getByLabelText(/value for the .*to.* input/i)).toBeTruthy();
  });
});
