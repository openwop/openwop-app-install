/**
 * Escape closes the palette wherever focus is, including before focus has
 * reached the search input. The e2e "Escape closes the palette" went red
 * under load because the only Escape handler was on the input (bcfd3c629).
 * Both cases ride the ONE window listener: case 2 pins that an Escape typed in
 * the input still bubbles to it.
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
});
