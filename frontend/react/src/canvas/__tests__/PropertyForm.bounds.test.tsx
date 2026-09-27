/**
 * DRAW-R4/DATA-D9 — the property widgets honor propDef bounds: number inputs
 * emit native min/max/step and clamp on BLUR (never mid-keystroke); string /
 * longtext inputs carry a native maxLength. The blur clamp reads the committed
 * value, so rendering an out-of-range value and blurring re-commits the bound.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach } from 'vitest';
import { PropertyField } from '../PropertyForm.js';
import type { CanvasPropDef } from '../types.js';

afterEach(cleanup);

function renderField(def: CanvasPropDef, value: unknown, onChange = vi.fn()): { onChange: typeof onChange } {
  render(<PropertyField def={def} value={value} frames={[]} docState={{}} orgId="o" onChange={onChange} onChangeText={() => {}} />);
  return { onChange };
}

describe('DRAW-R4 — property widget bounds', () => {
  it('a number field emits native min/max/step', () => {
    renderField({ name: 'opacity', type: 'number', label: 'Opacity', min: 0, max: 1, step: 0.05 }, 0.5);
    const input = screen.getByLabelText('Opacity') as HTMLInputElement;
    expect(input.min).toBe('0');
    expect(input.max).toBe('1');
    expect(input.step).toBe('0.05');
  });

  it('blur clamps an over-max committed value and re-commits the bound', () => {
    const { onChange } = renderField({ name: 'strokeWidth', type: 'number', label: 'Stroke width', min: 0, max: 100 }, 150);
    fireEvent.blur(screen.getByLabelText('Stroke width'));
    expect(onChange).toHaveBeenCalledWith('strokeWidth', 100);
  });

  it('blur clamps an under-min committed value up to the floor', () => {
    const { onChange } = renderField({ name: 'size', type: 'number', label: 'Size', min: 0.5, max: 100 }, 0.1);
    fireEvent.blur(screen.getByLabelText('Size'));
    expect(onChange).toHaveBeenCalledWith('size', 0.5);
  });

  it('blur leaves an in-range value untouched (no spurious history entry)', () => {
    const { onChange } = renderField({ name: 'strokeWidth', type: 'number', label: 'Stroke width', min: 0, max: 100 }, 40);
    fireEvent.blur(screen.getByLabelText('Stroke width'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('blur passes a cleared (undefined) value through — never snaps blank to min', () => {
    const { onChange } = renderField({ name: 'size', type: 'number', label: 'Size', min: 0.5, max: 100 }, undefined);
    fireEvent.blur(screen.getByLabelText('Size'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a string field carries a native maxLength', () => {
    renderField({ name: 'text', type: 'string', label: 'Text', maxLength: 400 }, 'hi');
    expect((screen.getByLabelText('Text') as HTMLInputElement).maxLength).toBe(400);
  });

  it('a longtext field carries a native maxLength', () => {
    render(<PropertyField def={{ name: 'note', type: 'longtext', label: 'Note', maxLength: 200 }} value="" frames={[]} docState={{}} orgId="o" onChange={() => {}} onChangeText={() => {}} />);
    expect((screen.getByLabelText('Note') as HTMLTextAreaElement).maxLength).toBe(200);
  });
});
