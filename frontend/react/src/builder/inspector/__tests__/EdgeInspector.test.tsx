import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { EdgeInspector } from '../EdgeInspector.js';
import type { BuilderEdge } from '../../schema/workflow.js';

afterEach(cleanup);

/**
 * Verifies the Field-primitive migration of EdgeInspector's four labelled
 * controls. With a condition path + an `eq` op set, all four (Label, Path,
 * Operator, Value) render and resolve by accessible label.
 */
const edge: BuilderEdge = {
  id: 'e1', source: 'a', sourcePort: 'out', target: 'b', targetPort: 'in',
  label: 'on success',
  condition: { path: 'completion', op: 'eq', value: 'done' },
};

describe('EdgeInspector forms (Field migration)', () => {
  it('exposes Label / Path / Operator / Value by accessible label', () => {
    render(<EdgeInspector edge={edge} />);
    expect((screen.getByLabelText('Label (optional)') as HTMLInputElement).value).toBe('on success');
    expect((screen.getByLabelText('Path (into source output)') as HTMLInputElement).value).toBe('completion');
    expect(screen.getByLabelText('Operator').tagName).toBe('SELECT');
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('done');
  });
});
