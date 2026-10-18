/** ADR 0345 3d — the Data workspace tab: facet editors commit through the ONE
 *  chassis history seam (commitDoc), ids stay \w-safe, mock rows stay bounded
 *  (≤ 10 objects — larger or malformed input keeps the previous value, visibly). */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { DataWorkspace } from '../DataWorkspace.js';

afterEach(cleanup);

const MOCK_INVALID = 'Mock rows must be a JSON array of up to 10 objects — kept the previous value';

/** A commitDoc that applies mutations to the live doc and re-renders on EVERY
 *  commit — the same clone-commit contract the chassis editDoc provides. */
function mount(doc: Record<string, unknown>) {
  const announce = vi.fn();
  let view: ReturnType<typeof render>;
  const commit = (mutate: (next: Record<string, unknown>) => void): void => {
    mutate(doc);
    view.rerender(<DataWorkspace doc={{ ...doc }} commitDoc={commit} orgId="o1" onAnnounce={announce} />);
  };
  view = render(<DataWorkspace doc={doc} commitDoc={commit} orgId="o1" onAnnounce={announce} />);
  return { doc, announce };
}

const blurWith = (label: string, value: string): HTMLElement => {
  const el = screen.getByLabelText(label);
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
  return el;
};

describe('DataWorkspace', () => {
  it('adds a state variable with a \\w-safe generated id', () => {
    const { doc, announce } = mount({ name: 'A', screens: [] });
    fireEvent.click(screen.getByRole('button', { name: /Add variable/ }));
    expect(doc.stateVariables).toEqual([{ id: 'variable', type: 'string', initial: '' }]);
    expect(announce).toHaveBeenCalledWith('Added');
  });
  it('authors a data source with bounded sample rows for list bindings', () => {
    const { doc, announce } = mount({ name: 'A', screens: [] });
    fireEvent.click(screen.getByRole('button', { name: /Add data source/ }));

    blurWith('Fields (comma-separated)', 'title, status');
    blurWith('Sample rows (JSON array)', '[{"title":"Ship it","status":"ready"}]');
    expect(doc.dataSources).toEqual([{ id: 'source', name: 'New data source', fields: ['title', 'status'], rows: [{ title: 'Ship it', status: 'ready' }] }]);
    expect(announce).toHaveBeenCalledWith('Mock rows saved');

    // 11 rows — one past the bound — is refused and the saved rows survive.
    const eleven = JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ title: `row ${i}` })));
    const rows = blurWith('Sample rows (JSON array)', eleven);
    expect((doc.dataSources as { rows: unknown[] }[])[0]!.rows).toEqual([{ title: 'Ship it', status: 'ready' }]);
    expect(rows.getAttribute('aria-invalid')).toBe('true');
    expect(announce).toHaveBeenLastCalledWith(MOCK_INVALID);
  });
  it('adds a model with a default required field', () => {
    const { doc } = mount({ name: 'A', screens: [] });
    fireEvent.click(screen.getByRole('button', { name: /Add model/ }));
    expect(doc.models).toEqual([{ id: 'model', name: 'New model', fields: [{ name: 'name', type: 'string', required: true }] }]);
  });
  it('adds an operation with an ok mock; invalid mock JSON keeps the old value + announces', () => {
    const { doc, announce } = mount({ name: 'A', screens: [] });
    fireEvent.click(screen.getByRole('button', { name: /Add operation/ }));
    const ops = doc.operations as { id: string; mock?: { rows?: unknown[] } }[];
    expect(ops).toEqual([{ id: 'operation', name: 'New operation', kind: 'list', mock: { status: 'ok', rows: [] } }]);
    // A NON-empty previous value, so "kept" cannot be confused with a reset.
    blurWith('Mock rows (JSON array)', '[{"a":1}]');
    expect(ops[0]!.mock).toEqual({ status: 'ok', rows: [{ a: 1 }] });
    const rows = blurWith('Mock rows (JSON array)', 'not json');
    expect(ops[0]!.mock).toEqual({ status: 'ok', rows: [{ a: 1 }] });
    expect(rows.getAttribute('aria-invalid')).toBe('true');
    expect(announce).toHaveBeenLastCalledWith(MOCK_INVALID);
    // The rejection is visible, not only announced (AB-UX-2).
    expect(screen.getByText(MOCK_INVALID)).toBeTruthy();
  });
  it('renders the entity graph once models exist', () => {
    mount({
      name: 'A', screens: [],
      models: [
        { id: 'task', name: 'Task', fields: [{ name: 'title', type: 'string' }], relationships: [{ to: 'user', kind: 'belongsTo' }] },
        { id: 'user', name: 'User', fields: [{ name: 'email', type: 'string' }] },
      ],
    });
    const region = screen.getByRole('region', { name: 'Entity relationships' });
    const rels = within(region).getByRole('list', { name: 'Relationships' });
    const kind = within(rels).getByRole('combobox', { name: 'Relationship kind' }) as HTMLSelectElement;
    expect(kind.value).toBe('belongsTo');
    expect(within(rels).getByText('Task')).toBeTruthy();
    expect(within(rels).getByText('User')).toBeTruthy();
  });
});
