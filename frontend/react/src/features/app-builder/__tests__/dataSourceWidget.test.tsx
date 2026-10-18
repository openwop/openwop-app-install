/**
 * The app-builder `dataSource` property widget (ADR 0323 Phase 3) — the
 * DataBinding picker for a `list`'s `bind`. Reads the doc's dataSources via the
 * chassis `docState` context and offers them as a declarative <select> (the
 * value stays a string id — export + validation unchanged).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { appBuilderDefinition } from '../definition.js';
import type { PropertyWidgetProps } from '../../../canvas/types.js';

const Widget = appBuilderDefinition.propertyWidgets!.dataSource!;

function props(over: { value?: unknown; docState?: Record<string, unknown> } = {}): PropertyWidgetProps {
  return {
    id: 'prop-bind',
    orgId: 'o1', // required by PropertyWidgetProps — the old Partial<> spread hid its absence
    def: { name: 'bind', type: 'dataSource', label: 'Data source' },
    value: '',
    onChange: vi.fn(),
    onChangeText: vi.fn(),
    frames: [],
    docState: { dataSources: [{ id: 'orders', name: 'Orders' }, { id: 'users', name: 'Users' }] },
    ...over,
  };
}

describe('DataSourceRefWidget', () => {
  it('lists the doc dataSources as options', () => {
    render(<Widget {...props()} />);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['—', 'Orders', 'Users']);
  });

  it('emits the chosen source id (a string, declarative)', () => {
    const p = props();
    render(<Widget {...p} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'users' } });
    expect(p.onChange).toHaveBeenCalledWith('users');
  });

  it('clearing emits undefined (removes the binding)', () => {
    const p = props({ value: 'orders' });
    render(<Widget {...p} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(p.onChange).toHaveBeenCalledWith(undefined);
  });

  it('shows an empty-state placeholder when the doc has no sources', () => {
    render(<Widget {...props({ docState: {} })} />);
    // only the placeholder option, and it SAYS there are none (not a bare '—')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['No data sources yet']);
  });
});
