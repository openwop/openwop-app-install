/**
 * ADR 0328 Phase 2 — the mediaRef property widget (choose / replace / clear),
 * plus the ADR 0342 Phase 0 (DS-06) manual-URL entry.
 *
 * Sabotage: drop `onChange(asset.serveUrl)` in the picker callback → case 1;
 * render the thumbnail without the value's src → case 2; Escape → commit →
 * case 4; `trimmed || undefined` → `trimmed` → case 5.
 *
 * Ceiling: `draftUrl.trim()` is a double guard — the input is `type="url"`, whose
 * value sanitization already strips leading/trailing whitespace (jsdom and
 * browsers alike), so dropping the `.trim()` alone changes nothing observable.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PropertyWidgetProps } from '../../../canvas/types.js';
import type { MediaAsset } from '../mediaClient.js';
import type { MediaPickerDialog as RealPicker } from '../MediaPickerDialog.js';
import { MediaRefWidget } from '../MediaRefWidget.js';

const PICKED = vi.hoisted((): MediaAsset => ({
  assetId: 'a1', orgId: 'org1', name: 'hero.png', contentType: 'image/png', sizeBytes: 10,
  tags: [], usageCount: 0, serveUrl: '/host/openwop-app/assets/tok_abc12345', serveToken: 'tok_abc12345',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}));
vi.mock('../MediaPickerDialog.js', () => ({
  MediaPickerDialog: ({ onSelect }: Parameters<typeof RealPicker>[0]) => (
    <button type="button" onClick={() => onSelect(PICKED)}>pick-fake</button>
  ),
}));

const base = {
  id: 'f1', orgId: 'org1',
  def: { name: 'imageUrl', type: 'mediaRef', label: 'Image' },
  frames: [], docState: {},
  onChangeText: () => undefined,
} satisfies Omit<PropertyWidgetProps, 'value' | 'onChange'>;

describe('MediaRefWidget', () => {
  it('choosing an asset stores its serve URL', () => {
    const onChange = vi.fn();
    render(<MediaRefWidget {...base} value={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose image' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick-fake' }));
    expect(onChange).toHaveBeenCalledWith('/host/openwop-app/assets/tok_abc12345');
  });

  it('an existing value shows a thumbnail, a Replace label, and a labeled Clear', () => {
    const onChange = vi.fn();
    const { container } = render(<MediaRefWidget {...base} value="/host/openwop-app/assets/tok_x1234567" onChange={onChange} />);
    // The thumbnail is decorative (alt="", aria-hidden) so it has no role; the
    // claim is that it shows THIS value.
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/host/openwop-app/assets/tok_x1234567');
    expect(screen.getByRole('button', { name: 'Replace image' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Image' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  // ADR 0342 Phase 0 (DS-06) — the manual-URL entry that keeps external-URL
  // capability when a raw string prop (app-builder image.src) becomes a mediaRef.
  it('the URL editor commits a typed external URL on Enter', () => {
    const onChange = vi.fn();
    render(<MediaRefWidget {...base} value={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use image URL' }));
    const input = screen.getByRole('textbox', { name: 'Image URL for Image' });
    fireEvent.change(input, { target: { value: '  https://example.com/pic.jpg  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('https://example.com/pic.jpg');
  });

  it('the URL editor pre-fills the current value, and Escape cancels without a change', () => {
    const onChange = vi.fn();
    render(<MediaRefWidget {...base} value="https://old.example/a.png" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use image URL' }));
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Image URL for Image' });
    expect(input.value).toBe('https://old.example/a.png');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    // The editor closed back to the picker buttons.
    expect(screen.getByRole('button', { name: 'Replace image' })).toBeTruthy();
  });

  it('clearing the URL field commits undefined (removes the ref)', () => {
    const onChange = vi.fn();
    render(<MediaRefWidget {...base} value="https://old.example/a.png" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use image URL' }));
    const input = screen.getByRole('textbox', { name: 'Image URL for Image' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
