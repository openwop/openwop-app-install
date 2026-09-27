/** ADR 0737 phase 3 — the logic workspace authors closed actions/bindings
 * through the canvas history seam; it never needs a second app store. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LogicWorkspace } from '../LogicWorkspace.js';

afterEach(cleanup);

function mount(doc: Record<string, unknown>) {
  const announce = vi.fn();
  let view: ReturnType<typeof render>;
  const commit = (mutate: (next: Record<string, unknown>) => void): void => {
    mutate(doc);
    view.rerender(<LogicWorkspace doc={{ ...doc }} commitDoc={commit} orgId="o1" onAnnounce={announce} />);
  };
  view = render(<LogicWorkspace doc={doc} commitDoc={commit} orgId="o1" onAnnounce={announce} />);
  return { doc, announce };
}

describe('LogicWorkspace', () => {
  it('authors a closed set-state action and two-way state binding on a selected control', () => {
    const { doc, announce } = mount({
      name: 'A',
      screens: [{ id: 'home', name: 'Home', components: [{ type: 'textInput', props: { label: 'Search' } }] }],
      stateVariables: [{ id: 'query', type: 'string', initial: '' }],
      operations: [{ id: 'search', name: 'Search', kind: 'list', mock: { status: 'ok', rows: [] } }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add action' }));
    fireEvent.change(screen.getByLabelText('Do'), { target: { value: 'set-state' } });
    fireEvent.change(screen.getByLabelText('State variable'), { target: { value: 'query' } });
    const value = screen.getByLabelText('Value (JSON or text)');
    fireEvent.change(value, { target: { value: '"ready"' } });
    fireEvent.blur(value);

    const node = ((doc.screens as { components: { actions?: Record<string, unknown>[] }[] }[])[0]!.components[0]!);
    expect(node.actions).toEqual([{ on: 'click', kind: 'set-state', state: 'query', value: 'ready' }]);

    fireEvent.click(screen.getByRole('button', { name: 'Add binding' }));
    expect(node).toMatchObject({ bindings: { value: { path: 'state.query', mode: 'one-way' } } });
    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'two-way' } });
    expect(node).toMatchObject({ bindings: { value: { path: 'state.query', mode: 'two-way' } } });
    expect(announce).toHaveBeenCalledWith('Action added');
    expect(announce).toHaveBeenCalledWith('Binding added');
  });
});
