/**
 * ViewportSurface (ADR 0333 Phase 1) — the jsdom-provable half: zoom chrome
 * (readout, ±, reset), identity-transform omission, and a11y labels. Gesture
 * geometry (wheel/pinch/Space-pan) is proven via the pure `viewport.ts` suite
 * — jsdom has no rects (the GraphSurface precedent).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewportSurface } from '../ViewportSurface.js';

function stage(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.cv-viewport__stage');
  expect(el).not.toBeNull();
  return el!;
}

describe('ViewportSurface', () => {
  it('renders the scene child inside an untransformed stage at identity', () => {
    const { container } = render(
      <ViewportSurface><svg data-testid="scene" /></ViewportSurface>,
    );
    expect(screen.getByTestId('scene')).toBeTruthy();
    // Identity omits the transform entirely — byte-identical pre-viewport layout.
    expect(stage(container).style.transform).toBe('');
  });

  it('zooms in/out from the chrome and shows a percent readout', () => {
    const { container } = render(<ViewportSurface><svg /></ViewportSurface>);
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    fireEvent.click(zoomIn);
    expect(screen.getByRole('button', { name: /120%/ })).toBeTruthy();
    expect(stage(container).style.transform).toContain('scale(1.2');
    fireEvent.click(zoomOut);
    expect(screen.getByRole('button', { name: /100%/ })).toBeTruthy();
  });

  it('Zoom-to-fit (the % preset menu, §7.3/CV-3) returns to the fitted view', () => {
    const { container } = render(<ViewportSurface><svg /></ViewportSurface>);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    // The % readout is now a menu trigger; fit lives inside it.
    fireEvent.click(screen.getByRole('button', { name: /presets & fit/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Zoom to fit/ }));
    expect(stage(container).style.transform).toBe('');
    expect(screen.getByRole('button', { name: /100%/ })).toBeTruthy();
  });

  it('the preset menu jumps to an absolute percent (§7.3/CV-3)', () => {
    const { container } = render(<ViewportSurface><svg /></ViewportSurface>);
    fireEvent.click(screen.getByRole('button', { name: /presets & fit/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '200%' }));
    expect(stage(container).style.transform).toContain('scale(2');
    expect(screen.getByRole('button', { name: /Zoom 200%/ })).toBeTruthy();
  });

  it('respects zoom limits', () => {
    render(<ViewportSurface limits={{ min: 1, max: 1.2 }}><svg /></ViewportSurface>);
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    fireEvent.click(zoomIn);
    fireEvent.click(zoomIn);
    fireEvent.click(zoomIn);
    expect(screen.getByRole('button', { name: /120%/ })).toBeTruthy();
  });

  it('labels the chrome group for AT', () => {
    render(<ViewportSurface><svg /></ViewportSurface>);
    expect(screen.getByRole('group', { name: 'Zoom' })).toBeTruthy();
  });
});
