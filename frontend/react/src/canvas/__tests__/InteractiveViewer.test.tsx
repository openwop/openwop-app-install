/**
 * InteractiveViewer — tap-through navigation + the audit-gap-#4 transitions.
 * A fake Renderer stamps a data-cv-nav button so the delegated click path is
 * exercised; transitions apply on TAP navigation (the flow gesture, keyed by
 * the connector) and not on tab-strip navigation (chrome).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InteractiveViewer } from '../InteractiveViewer.js';
import { NAV_ATTR } from '../dnd.js';

const doc = {
  name: 'App',
  screens: [
    { id: 'home', name: 'Home', isInitial: true },
    { id: 'next', name: 'Next' },
  ],
};

// Renders a nav button targeting `next` regardless of content — enough to
// exercise the delegated [data-cv-nav] click path.
function FakeRenderer(): JSX.Element {
  return <button type="button" {...{ [NAV_ATTR]: 'next' }}>Go next</button>;
}

function setup(transitionFor?: (f: string, t: string) => string | undefined) {
  return render(
    <InteractiveViewer
      doc={doc}
      Renderer={FakeRenderer}
      noFramesText="none"
      framesLabel="Screens"
      {...(transitionFor ? { transitionFor } : {})}
    />,
  );
}

describe('InteractiveViewer swipe + thumbnails (audit polish P1)', () => {
  // jsdom has no PointerEvent — dispatch MouseEvent-constructed events with the
  // pointer type names (React listens by name), which carry real coordinates.
  const pointer = (el: Element, type: 'pointerdown' | 'pointerup', x: number, y: number): void => {
    fireEvent(el, new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  };
  it('a horizontal swipe on the stage navigates to the next frame with a slide', () => {
    const { container } = setup();
    const stage = container.querySelector('.cv-viewer__stage')!;
    pointer(stage, 'pointerdown', 300, 100);
    pointer(stage, 'pointerup', 180, 108); // dx=-120 → next
    expect(screen.getByRole('tab', { name: 'Next' }).getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('.cv-viewer__framebox--t-slide')).toBeTruthy();
  });
  it('a short or vertical drag does NOT navigate', () => {
    const { container } = setup();
    const stage = container.querySelector('.cv-viewer__stage')!;
    pointer(stage, 'pointerdown', 300, 100);
    pointer(stage, 'pointerup', 270, 100); // dx=-30 < threshold
    pointer(stage, 'pointerdown', 300, 100);
    pointer(stage, 'pointerup', 200, 260); // vertical intent
    expect(screen.getByRole('tab', { name: 'Home' }).getAttribute('aria-selected')).toBe('true');
  });
  it('a drag starting on a tap target ([data-cv-nav]) never swipes', () => {
    setup();
    const navBtn = screen.getByRole('button', { name: 'Go next' });
    pointer(navBtn, 'pointerdown', 300, 100);
    pointer(navBtn, 'pointerup', 100, 100);
    expect(screen.getByRole('tab', { name: 'Home' }).getAttribute('aria-selected')).toBe('true');
  });
  it('thumbnails render inside tabs (opt-in) without changing the accessible name', () => {
    const { container } = render(
      <InteractiveViewer doc={doc} Renderer={FakeRenderer} noFramesText="none" framesLabel="Screens" thumbnails />,
    );
    expect(container.querySelectorAll('.cv-viewer__thumb').length).toBe(2);
    expect(screen.getByRole('tab', { name: 'Home' })).toBeTruthy(); // name = text label only
    expect(screen.getByRole('tab', { name: 'Next' })).toBeTruthy();
  });
});

describe('InteractiveViewer transitions (audit gap #4)', () => {
  it('tap-through applies the connector transition class (keyed remount)', () => {
    const transitionFor = vi.fn(() => 'push');
    const { container } = setup(transitionFor);
    fireEvent.click(screen.getByRole('button', { name: 'Go next' }));
    expect(transitionFor).toHaveBeenCalledWith('home', 'next');
    expect(container.querySelector('.cv-viewer__framebox--t-push')).toBeTruthy();
    // …and the active tab moved.
    expect(screen.getByRole('tab', { name: 'Next' }).getAttribute('aria-selected')).toBe('true');
  });

  it('"none" (or no transitionFor) swaps instantly with no animation class', () => {
    const { container } = setup(() => 'none');
    fireEvent.click(screen.getByRole('button', { name: 'Go next' }));
    expect(container.querySelector('[class*="cv-viewer__framebox--t-"]')).toBeNull();
  });

  it('tab-strip navigation stays instant (chrome, not a flow tap)', () => {
    const transitionFor = vi.fn(() => 'push');
    const { container } = setup(transitionFor);
    fireEvent.click(screen.getByRole('tab', { name: 'Next' }));
    expect(transitionFor).not.toHaveBeenCalled();
    expect(container.querySelector('[class*="cv-viewer__framebox--t-"]')).toBeNull();
  });
});
