/** ADR 0345 3d — the Data workspace tab: facet editors commit through the ONE
 *  chassis history seam (commitDoc), ids stay \w-safe, mock rows stay bounded. */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { DataWorkspace } from '../DataWorkspace.js';

afterEach(cleanup);

/** A commitDoc that applies mutations to a live doc and re-renders — the same
 *  clone-commit contract the chassis editDoc provides. */
function mount(doc: Record<string, unknown>) {
  const announce = vi.fn();
  const view = render(
    <DataWorkspace doc={doc} commitDoc={(m) => { m(doc); view.rerender(
      <DataWorkspace doc={{ ...doc }} commitDoc={(m2) => { m2(doc); }} orgId="o1" onAnnounce={announce} />,
    ); }} orgId="o1" onAnnounce={announce} />,
  );
  return { doc, announce, view };
}

describe('DataWorkspace', () => {
  it('adds a state variable with a \\w-safe generated id', () => {
    const { doc } = mount({ name: 'A', screens: [] });
    fireEvent.click(screen.getByRole('button', { name: /Add variable/ }));
    const vars = doc.stateVariables as { id: string; type: string }[];
    expect(vars).toHaveLength(1);
    expect(vars[0]!.id).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
  });
  it('authors a data source with bounded sample rows for list bindings', () => {
    const { doc, announce } = mount({ name: 'A', screens: [] });
    fireEvent.click(screen.getByRole('button', { name: /Add data source/ }));
    const sources = doc.dataSources as { id: string; name: string; fields: string[]; rows: unknown[] }[];
    expect(sources).toHaveLength(1);
    expect(sources[0]!.id).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);

    fireEvent.change(screen.getByLabelText('Fields (comma-separated)'), { target: { value: 'title, status' } });
    fireEvent.blur(screen.getByLabelText('Fields (comma-separated)'));
    fireEvent.change(screen.getByLabelText('Sample rows (JSON array)'), { target: { value: '[{"title":"Ship it","status":"ready"}]' } });
    fireEvent.blur(screen.getByLabelText('Sample rows (JSON array)'));

    expect(sources[0]!.fields).toEqual(['title', 'status']);
    expect(sources[0]!.rows).toEqual([{ title: 'Ship it', status: 'ready' }]);
    expect(announce).toHaveBeenCalledWith('Mock rows saved');
  });
  it('adds a model with a default required field', () => {
    const { doc } = mount({ name: 'A', screens: [] });
    fireEvent.click(screen.getByRole('button', { name: /Add model/ }));
    const models = doc.models as { id: string; fields: { name: string }[] }[];
    expect(models).toHaveLength(1);
    expect(models[0]!.fields[0]!.name).toBe('name');
  });
  it('adds an operation with an ok mock; invalid mock JSON keeps the old value + announces', () => {
    const { doc, announce } = mount({ name: 'A', screens: [] });
    fireEvent.click(screen.getByRole('button', { name: /Add operation/ }));
    const ops = doc.operations as { id: string; mock?: { rows?: unknown[] } }[];
    expect(ops).toHaveLength(1);
    const rows = screen.getByLabelText('Mock rows (JSON array)');
    fireEvent.change(rows, { target: { value: 'not json' } });
    fireEvent.blur(rows);
    expect(ops[0]!.mock?.rows).toEqual([]);
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('kept the previous value'));
  });
  it('renders the entity graph once models exist', () => {
    const { view } = mount({
      name: 'A', screens: [],
      models: [
        { id: 'task', name: 'Task', fields: [{ name: 'title', type: 'string' }], relationships: [{ to: 'user', kind: 'belongsTo' }] },
        { id: 'user', name: 'User', fields: [{ name: 'email', type: 'string' }] },
      ],
    });
    expect(view.container.textContent).toContain('Entity relationships');
    expect(view.container.textContent).toContain('belongsTo');
  });
});
