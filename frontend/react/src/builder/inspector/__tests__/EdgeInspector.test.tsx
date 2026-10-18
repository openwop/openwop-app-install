import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { EdgeInspector } from '../EdgeInspector.js';
import type { BuilderEdge } from '../../schema/workflow.js';

afterEach(cleanup);

/**
 * Field-primitive migration (#66 / #69) of EdgeInspector's four labelled
 * controls: with a condition path + a value-taking op set, all four (Label,
 * Path, Operator, Value) render, resolve by accessible label, and show the
 * edge's values. Breaks if a control loses its label association or stops
 * reflecting the edge. The operator is `neq`, NOT the component's `eq`
 * default, so a hard-wired default cannot pass.
 *
 * Out of this claim (grade-code row): the trigger-rule <select> above the
 * condition has no accessible label at all.
 */
const edge: BuilderEdge = {
  id: 'e1', source: 'a', sourcePort: 'out', target: 'b', targetPort: 'in',
  label: 'on success',
  condition: { path: 'completion', op: 'neq', value: 'done' },
};

describe('EdgeInspector forms (Field migration)', () => {
  it('exposes Label / Path / Operator / Value by accessible label', () => {
    render(<EdgeInspector edge={edge} />);
    expect((screen.getByLabelText('Label (optional)') as HTMLInputElement).value).toBe('on success');
    expect((screen.getByLabelText('Path (into source output)') as HTMLInputElement).value).toBe('completion');
    const op = screen.getByLabelText('Operator') as HTMLSelectElement;
    expect(op.tagName).toBe('SELECT');
    expect(op.value).toBe('neq');
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('done');
  });
});
