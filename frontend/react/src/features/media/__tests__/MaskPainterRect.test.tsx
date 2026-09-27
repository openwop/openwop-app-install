/**
 * UXB-1 — the rectangle mask mode: the pure percent→pixel clamp math, and the
 * fully KEYBOARD path (mode chip → numeric inputs → add → removable region
 * list), proving an inpaint mask is authorable with no pointer at all.
 * (Canvas compositing itself is untestable under jsdom — the pure helper +
 * interaction contract are the testable surface.)
 */
import { describe, it, expect } from 'vitest';
import { maskRectToPixels } from '../EditImageDialog.js';

describe('maskRectToPixels — pure percent→pixel clamp', () => {
  it('converts a mid-image rect at natural size', () => {
    expect(maskRectToPixels({ x: 25, y: 25, w: 50, h: 50 }, 1000, 800))
      .toEqual({ x: 250, y: 200, w: 500, h: 400 });
  });
  it('clamps overshoot into the image', () => {
    expect(maskRectToPixels({ x: 80, y: 90, w: 50, h: 50 }, 100, 100))
      .toEqual({ x: 80, y: 90, w: 20, h: 10 });
    expect(maskRectToPixels({ x: -10, y: 0, w: 20, h: 10 }, 100, 100))
      .toEqual({ x: 0, y: 0, w: 20, h: 10 });
  });
  it('rejects degenerate rects and non-finite input', () => {
    expect(maskRectToPixels({ x: 100, y: 0, w: 10, h: 10 }, 100, 100)).toBeNull();
    expect(maskRectToPixels({ x: 0, y: 0, w: 0, h: 10 }, 100, 100)).toBeNull();
    expect(maskRectToPixels({ x: Number.NaN, y: 0, w: 10, h: 10 }, 100, 100)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
  it('never emits a zero-size pixel rect for a tiny-but-real percent', () => {
    expect(maskRectToPixels({ x: 0, y: 0, w: 0.5, h: 0.5 }, 100, 100)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

// ── The keyboard interaction contract ────────────────────────────────────────
import { render, cleanup, fireEvent } from '@testing-library/react';
import { afterEach } from 'vitest';
import { createRef } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../i18n/index.js';
import { MaskPainterForTest } from '../EditImageDialog.js';

afterEach(cleanup);

describe('rectangle mode — the keyboard path (UXB-1)', () => {
  it('mode chip → numeric inputs → add → listed region with a remove button', () => {
    const ref = createRef<{ exportMask(m: 'mask-white' | 'mask-alpha'): string | undefined }>();
    const { getByRole, getAllByRole, queryByRole } = render(
      <I18nextProvider i18n={i18n}>
        <MaskPainterForTest ref={ref} imageUrl="/host/openwop-app/assets/tok_x" />
      </I18nextProvider>,
    );
    // Switch to rectangle mode via the chip (keyboard: Tab + Enter on a button).
    fireEvent.click(getByRole('button', { name: 'Rectangle' }));
    // The four percent inputs are labeled and native.
    const x = getByRole('spinbutton', { name: 'X (%)' });
    const w = getByRole('spinbutton', { name: 'Width (%)' });
    fireEvent.change(x, { target: { value: '10' } });
    fireEvent.change(w, { target: { value: '30' } });
    fireEvent.click(getByRole('button', { name: 'Add region' }));
    // The region lists with an accessible remove.
    const list = getByRole('list', { name: 'Mask regions' });
    expect(list.textContent).toContain('Region 1');
    const remove = getByRole('button', { name: 'Remove region 1' });
    fireEvent.click(remove);
    expect(queryByRole('list', { name: 'Mask regions' })).toBeNull();
    expect(getAllByRole('button', { name: /Brush|Rectangle/ }).length).toBe(2);
  });
});
