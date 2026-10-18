import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TextField, TextareaField, SelectField, Field, CheckboxField } from '../Field.js';

afterEach(cleanup);

/** The text of every element `aria-describedby` points at, in order. */
const describedTexts = (el: HTMLElement): string[] =>
  (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`);

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
    expect(describedTexts(input)).toEqual(['We never share it']);
  });

  it('sets aria-invalid and an alert when error is present, and describes the control by help + error', () => {
    render(<TextField label="Token" help="From your dashboard" error="Required" value="" onChange={() => {}} />);
    const input = screen.getByLabelText('Token');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('Required');
    // The error is wired into aria-describedby too (after the help), so a screen
    // reader reads it when the control takes focus — not only once as an alert.
    expect(describedTexts(input)).toEqual(['From your dashboard', 'Required']);
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

describe('CheckboxField label register (RFCW-UX-7)', () => {
  it('the option text rides .field-check-label — content in sans, not the mono caption register', () => {
    render(<CheckboxField label="Auto-translate on submit" />);
    const label = screen.getByText('Auto-translate on submit').closest('label');
    expect(label?.classList.contains('field-check-label')).toBe(true);
  });
});
