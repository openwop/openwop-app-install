/**
 * CAD-G1/CAD-G3 — the material picker renders LABELS and the catalog colour.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CadMaterialWidget } from '../CadMaterialWidget.js';
import { CAD_MATERIALS } from '../cadMaterials.js';

afterEach(cleanup);

const view = (value: string, onChange = vi.fn()): { onChange: ReturnType<typeof vi.fn>; container: HTMLElement } => {
  const { container } = render(
    <CadMaterialWidget
      id="mat"
      def={{ name: 'materialId', type: 'cad-material', label: 'Material', options: CAD_MATERIALS.map((m) => m.id) }}
      value={value}
      frames={[]}
      docState={{}}
      orgId="o1"
      onChange={onChange}
      onChangeText={() => {}}
    />,
  );
  return { onChange, container };
};

describe('CadMaterialWidget', () => {
  it('labels options, never the kebab wire token', () => {
    view('steel');
    // 'plastic-red' is the id; the option must not read as the id.
    expect(screen.getByRole('option', { name: 'Plastic — red' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'plastic-red' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Wood — oak' })).toBeTruthy();
  });

  it('shows the selected material’s catalog colour as a swatch', () => {
    const { container } = view('brass');
    const swatch = container.querySelector('.cad-material__swatch') as HTMLElement;
    const brass = CAD_MATERIALS.find((m) => m.id === 'brass')!;
    // The colour comes from the catalog — the widget authors none. jsdom
    // normalizes the hex to rgb(), so compare against the catalog value
    // converted the same way rather than asserting merely "some rgb".
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(brass.color.slice(i, i + 2), 16));
    expect(swatch.style.background).toBe(`rgb(${r}, ${g}, ${b})`);
    // Presentational: it restates the select, so it must not be announced.
    expect(swatch.getAttribute('aria-hidden')).toBe('true');
  });

  it('has no swatch when nothing is selected — inline colour applies', () => {
    const { container } = view('');
    expect(container.querySelector('.cad-material__swatch')).toBeNull();
    expect(screen.getByRole('option', { name: '— inline colour —' })).toBeTruthy();
  });

  it('an unknown stored id shows no swatch rather than a wrong one', () => {
    // A doc written by an older/newer catalog must not paint a swatch it cannot
    // resolve.
    const { container } = view('unobtanium');
    expect(container.querySelector('.cad-material__swatch')).toBeNull();
  });

  it('clearing writes the empty value the chassis turns into a delete', () => {
    const { onChange } = view('gold');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    // `setFieldOn` deletes the key on '' — an out-of-enum '' must never persist.
    expect(onChange).toHaveBeenCalledWith('');
  });
});
