/**
 * ColorField (ADR 0333 Phase 6) — swatch semantics, none, hex escape hatch.
 * jsdom resolves no custom properties, so the theme swatch row is empty here;
 * the none swatch + inputs prove the interaction contract.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ColorField } from '../ColorField.js';

describe('ColorField', () => {
  it('renders the labeled swatch group, none swatch, and hex input', () => {
    const onChange = vi.fn();
    render(<ColorField id="f" value="" onChange={onChange} hexAriaLabel="Fill color" />);
    expect(screen.getByRole('group', { name: 'Theme colors' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    fireEvent.change(screen.getByLabelText('Fill color'), { target: { value: 'tomato' } });
    expect(onChange).toHaveBeenNthCalledWith(1, 'none');
    expect(onChange).toHaveBeenNthCalledWith(2, 'tomato');
    expect(onChange).toHaveBeenCalledTimes(2);
  });
  it('marks the active value with aria-pressed', () => {
    const { rerender } = render(<ColorField id="f" value="none" onChange={() => undefined} hexAriaLabel="Fill color" />);
    expect(screen.getByRole('button', { name: 'None' }).getAttribute('aria-pressed')).toBe('true');
    // …and NOT pressed when another value is active (a stuck `true` is caught).
    rerender(<ColorField id="f" value="#123456" onChange={() => undefined} hexAriaLabel="Fill color" />);
    expect(screen.getByRole('button', { name: 'None' }).getAttribute('aria-pressed')).toBe('false');
  });
  it('omits the none swatch when allowNone is false', () => {
    render(<ColorField id="f" value="" onChange={() => undefined} hexAriaLabel="Fill color" allowNone={false} />);
    expect(screen.queryByRole('button', { name: 'None' })).toBeNull();
  });
  it('clearing the hex input reports undefined (field deletion)', () => {
    const onChange = vi.fn();
    render(<ColorField id="f" value="x" onChange={onChange} hexAriaLabel="Fill color" />);
    fireEvent.change(screen.getByLabelText('Fill color'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
  it('a theme swatch is a labeled button that picks its resolved value, matched case-insensitively', () => {
    document.documentElement.style.setProperty('--ink', '#AABBCC');
    try {
      const onChange = vi.fn();
      render(<ColorField id="f" value="#aabbcc" onChange={onChange} hexAriaLabel="Fill color" />);
      const swatch = screen.getByRole('button', { name: 'Text' });
      expect(swatch.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(swatch);
      expect(onChange).toHaveBeenCalledWith('#AABBCC');
    } finally {
      document.documentElement.style.removeProperty('--ink');
    }
  });
});
