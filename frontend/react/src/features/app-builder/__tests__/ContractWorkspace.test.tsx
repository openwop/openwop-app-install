/** ADR 0737 phase 3 — contract facets are human-editable, not merely carried
 * through coerceApp and hidden until an export/preflight discovers them. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ContractWorkspace } from '../ContractWorkspace.js';

afterEach(cleanup);

function mount(doc: Record<string, unknown>) {
  const announce = vi.fn();
  let view: ReturnType<typeof render>;
  const commit = (mutate: (next: Record<string, unknown>) => void): void => {
    mutate(doc);
    view.rerender(<ContractWorkspace doc={{ ...doc }} commitDoc={commit} orgId="o1" onAnnounce={announce} />);
  };
  view = render(<ContractWorkspace doc={doc} commitDoc={commit} orgId="o1" onAnnounce={announce} />);
  return { doc, announce };
}

describe('ContractWorkspace', () => {
  it('authors references, guarded auth, environment requirements, and a truthful share policy', () => {
    const { doc, announce } = mount({
      name: 'A',
      screens: [{ id: 'home', name: 'Home', components: [] }, { id: 'login', name: 'Login', components: [] }],
      dataSources: [{ id: 'customers', name: 'Customers', rows: [{ name: 'Ada' }] }],
    });
    const designSystem = screen.getByLabelText('Design system reference');
    fireEvent.change(designSystem, { target: { value: 'ds_aurora' } });
    fireEvent.blur(designSystem);
    expect(doc.designSystemRef).toEqual({ id: 'ds_aurora' });

    fireEvent.change(screen.getByLabelText('Sign-in method'), { target: { value: 'sso' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add role' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add guard' }));
    expect(doc.authProfile).toMatchObject({ kind: 'sso', roles: ['role_1'], guards: [{ screenId: 'home' }] });

    fireEvent.click(screen.getByRole('button', { name: 'Add requirement' }));
    expect(doc.envRequirements).toEqual([{ key: 'NEW_ENV', purpose: 'Describe why this setting is needed', requiredFor: ['runtime'] }]);
    expect(announce).toHaveBeenCalledWith('Environment requirement added');

    fireEvent.change(screen.getByLabelText('Default sample-data policy'), { target: { value: 'include' } });
    fireEvent.change(screen.getByLabelText('Customers override'), { target: { value: 'redact' } });
    expect(doc.sharePolicy).toEqual({ sampleData: 'include', perSource: { customers: false } });
  });
});
