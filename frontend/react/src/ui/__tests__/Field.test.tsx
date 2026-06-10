import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TextField, TextareaField, SelectField, Field } from '../Field.js';

afterEach(cleanup);

/**
 * Proves the Field primitive's accessibility contract — the wiring every
 * hand-rolled label/input in the app was missing
 * (jsx-a11y/label-has-associated-control): label↔control association,
 * aria-describedby for help+error, and aria-invalid on error.
 */
describe('Field primitive accessibility wiring', () => {
  it('associates the label with the input (getByLabelText resolves)', () => {
    render(<TextField label="Display name" value="x" onChange={() => {}} />);
    expect(screen.getByLabelText('Display name')).toBeTruthy();
  });

  it('wires help text via aria-describedby', () => {
    render(<TextField label="Email" help="We never share it" value="" onChange={() => {}} />);
    const input = screen.getByLabelText('Email');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!.split(' ')[0]!)?.textContent).toContain('never share');
  });

  it('sets aria-invalid and an alert when error is present', () => {
    render(<TextField label="Token" error="Required" value="" onChange={() => {}} />);
    const input = screen.getByLabelText('Token');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('Required');
  });

  it('marks required fields with aria-required', () => {
    render(<TextField label="Name" required value="" onChange={() => {}} />);
    expect(screen.getByLabelText(/Name/).getAttribute('aria-required')).toBe('true');
  });

  it('works for textarea and select too', () => {
    render(<TextareaField label="Notes" value="" onChange={() => {}} />);
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
    cleanup();
    render(
      <SelectField label="Kind" value="a" onChange={() => {}}>
        <option value="a">A</option>
      </SelectField>,
    );
    expect(screen.getByLabelText('Kind').tagName).toBe('SELECT');
  });

  it('supports a render-prop control with full wiring', () => {
    render(
      <Field label="Custom" error="bad">
        {(w) => <input {...w} data-testid="c" />}
      </Field>,
    );
    const input = screen.getByTestId('c');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Custom')).toBe(input);
  });
});
