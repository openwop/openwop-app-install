/**
 * UX_UPGRADE-app-builder AB-G3 — an identifier RENAME is checked where it is
 * made, not at save time.
 *
 * `validateAppDoc` treats a non-`\w` or duplicate state-variable id / model
 * field name as a BLOCKING error (`bad()`, not `warn()`), so one such rename
 * makes the whole document unsaveable. Creation was already guarded by `slug()`
 * with a taken-set; renaming had no check at all, so the failure surfaced only
 * on the next save — by which time the user had made other edits and had no
 * reason to connect the two.
 *
 * The positive cases matter as much as the negative ones: a mirror of the server
 * rule that is too strict would flag valid identifiers and block real work.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DataWorkspace } from '../DataWorkspace.js';

afterEach(cleanup);

const mount = (doc: Record<string, unknown>): { doc: Record<string, unknown> } => {
  const announce = vi.fn();
  const view = render(<DataWorkspace doc={doc} commitDoc={(m) => { m(doc); view.rerender(<DataWorkspace doc={{ ...doc }} commitDoc={(m2) => { m2(doc); }} orgId="o1" onAnnounce={announce} />); }} orgId="o1" onAnnounce={announce} />);
  return { doc };
};

const rename = (label: string, value: string, nth = 0): HTMLElement => {
  const input = screen.getAllByLabelText(label)[nth]!;
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
  return input;
};

describe('AB-G3 — state-variable id renames', () => {
  it('flags a malformed id at the point of the edit', () => {
    mount({ name: 'A', screens: [], stateVariables: [{ id: 'count', type: 'number', initial: 0 }] });
    const input = rename('Variable id', 'my var');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    // Announced, not merely coloured.
    expect(screen.getByRole('alert').textContent).toContain('generated identifier');
  });

  it('flags a duplicate on the SECOND row, not the first', () => {
    mount({ name: 'A', screens: [], stateVariables: [
      { id: 'count', type: 'number', initial: 0 },
      { id: 'total', type: 'number', initial: 0 },
    ] });
    rename('Variable id', 'count', 1);
    const inputs = screen.getAllByLabelText('Variable id');
    // The row the user just renamed is the one that lights up — flagging the
    // original would point at a value they did not touch.
    expect(inputs[0]!.getAttribute('aria-invalid')).toBeNull();
    expect(inputs[1]!.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('unique');
  });

  it('leaves a valid rename alone', () => {
    mount({ name: 'A', screens: [], stateVariables: [{ id: 'count', type: 'number', initial: 0 }] });
    const input = rename('Variable id', 'itemCount_2');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('accepts a leading underscore — the server rule allows it', () => {
    mount({ name: 'A', screens: [], stateVariables: [{ id: 'count', type: 'number', initial: 0 }] });
    const input = rename('Variable id', '_private');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('rejects a leading digit — the server rule does not allow it', () => {
    mount({ name: 'A', screens: [], stateVariables: [{ id: 'count', type: 'number', initial: 0 }] });
    const input = rename('Variable id', '2fast');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('AB-G3 — model field-name renames', () => {
  const doc = (): Record<string, unknown> => ({
    name: 'A', screens: [],
    models: [{ id: 'order', name: 'Order', fields: [{ name: 'total', type: 'number' }, { name: 'sku', type: 'string' }] }],
  });

  it('flags a malformed field name', () => {
    mount(doc());
    const input = rename('Field name', 'unit price');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('flags a field name duplicated within the SAME model', () => {
    mount(doc());
    rename('Field name', 'total', 1);
    const inputs = screen.getAllByLabelText('Field name');
    expect(inputs[0]!.getAttribute('aria-invalid')).toBeNull();
    expect(inputs[1]!.getAttribute('aria-invalid')).toBe('true');
  });

  it('does NOT flag the same field name reused in a DIFFERENT model', () => {
    // Field names are unique per model server-side; a cross-model check would
    // block a perfectly valid document.
    mount({
      name: 'A', screens: [],
      models: [
        { id: 'order', name: 'Order', fields: [{ name: 'total', type: 'number' }] },
        { id: 'invoice', name: 'Invoice', fields: [{ name: 'total', type: 'number' }] },
      ],
    });
    for (const input of screen.getAllByLabelText('Field name')) {
      expect(input.getAttribute('aria-invalid')).toBeNull();
    }
  });
});
