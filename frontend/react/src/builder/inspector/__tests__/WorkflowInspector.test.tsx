import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { WorkflowInspector } from '../WorkflowInspector.js';
import { useBuilderStore } from '../../store/builderStore.js';

afterEach(cleanup);

/**
 * Verifies the Field-primitive migration of WorkflowInspector: the workflow
 * name + default-inputs controls resolve by accessible label, reflect the
 * builder-store values, and the default-inputs help text renders via Field's
 * `help` slot.
 */
describe('WorkflowInspector forms (Field migration)', () => {
  it('renders store-backed, label-associated controls', () => {
    useBuilderStore.getState().setName('My flow');
    useBuilderStore.getState().setDefaultInputs('{"x":1}');
    render(<WorkflowInspector />);

    const nameInput = screen.getByLabelText('Workflow name') as HTMLInputElement;
    expect(nameInput.value).toBe('My flow');

    const inputsArea = screen.getByLabelText('Default inputs (JSON)') as HTMLTextAreaElement;
    expect(inputsArea.value).toBe('{"x":1}');
    // help text wired via aria-describedby
    const describedBy = inputsArea.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain('ctx.inputs');
  });
});
