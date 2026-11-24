/**
 * Escape closes the palette wherever focus is, including before focus has
 * reached the search input. The e2e "Escape closes the palette" went red
 * under load because the only Escape handler was on the input (bcfd3c629).
 * Both cases ride the ONE window listener: case 2 pins that an Escape typed in
 * the input still bubbles to it.
 *
 * 2026-11-24 (train 516's e2e red, DeckTalk twice): that window listener was a
 * passive effect, attached AFTER paint. So the dialog was visible with no
 * listener yet, and an Escape in that window was lost. RTL's act() flushes
 * passive effects before it returns, which is why the two cases above never saw
 * it. The before-paint witness lives in `CommandPalette.escapeBeforePaint.test.tsx`
 * because it must run in a file that never enters act(). MEASURED: after an
 * act() render in the same file, React flushed passive effects before the
 * microtask, and the witness stayed green on the bug. Case 3 here pins the
 * dialog's own onKeyDown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CommandPalette } from '../CommandPalette.js';

vi.mock('../../chrome/navConfig/NavConfigProvider.js', () => ({
  useResolvedNav: () => ({ workspace: [], admin: [], site: [], degraded: false }),
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  useFeatureBadge: () => () => null,
  useFeatureLocked: () => () => false,
}));

afterEach(cleanup);

Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn(),
});

describe('CommandPalette — Escape', () => {
  it('closes when Escape arrives while focus is still on the page, not the input', () => {
    render(<MemoryRouter><CommandPalette openSignal={1} /></MemoryRouter>);
    expect(screen.getByRole('dialog')).toBeTruthy();

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still closes on Escape from the search input', () => {
    render(<MemoryRouter><CommandPalette openSignal={1} /></MemoryRouter>);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes from the dialog\'s own onKeyDown, even with no window listener reached', () => {
    render(<MemoryRouter><CommandPalette openSignal={1} /></MemoryRouter>);
    const dialog = screen.getByRole('dialog');
    // A keydown on the panel whose window bubbling is stopped: only the panel's
    // React handler can close it.
    const stop = (e: KeyboardEvent): void => { e.stopPropagation(); };
    document.addEventListener('keydown', stop);
    try {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', stop);
    }
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
