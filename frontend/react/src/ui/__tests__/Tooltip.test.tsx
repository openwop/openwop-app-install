import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Tooltip } from '../Tooltip.js';

afterEach(cleanup);

describe('Tooltip', () => {
  it('describes an existing control on hover and keyboard focus, then dismisses on Escape', () => {
    render(<Tooltip text="Library"><a href="/library">Open</a></Tooltip>);
    const link = screen.getByRole('link', { name: 'Open' });
    fireEvent.focus(link);
    const tip = screen.getByRole('tooltip', { name: 'Library' });
    expect(link.getAttribute('aria-describedby')).toBe(tip.id);
    fireEvent.keyDown(link, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    // HOVER is the other half of the title — it was never driven (w49 probe
    // `tip-hover`). The handlers sit on the anchor span that wraps the child.
    const anchor = link.parentElement as HTMLElement;
    fireEvent.mouseEnter(anchor);
    const hovered = screen.getByRole('tooltip', { name: 'Library' });
    expect(link.getAttribute('aria-describedby')).toBe(hovered.id);
    fireEvent.mouseLeave(anchor);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does not alter the child when disabled', () => {
    render(<Tooltip text="Library" disabled><a href="/library">Open</a></Tooltip>);
    const link = screen.getByRole('link', { name: 'Open' });
    fireEvent.focus(link);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(link.getAttribute('aria-describedby')).toBeNull();
  });
});
