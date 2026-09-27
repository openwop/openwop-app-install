/**
 * InfoTip (STRATUX-5) — the keyboard-discoverable tooltip primitive. Locks the
 * WAI-ARIA contract: a focusable button trigger with an accessible name, the
 * bubble linked via aria-describedby and role="tooltip", shown on focus,
 * dismissed on Escape/blur.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { InfoTip } from '../InfoTip.js';

afterEach(cleanup);

describe('InfoTip', () => {
  it('exposes a focusable, accessibly-named trigger', () => {
    render(<InfoTip label="What is this rank?" text="Rank in its priority list." />);
    const trigger = screen.getByRole('button', { name: 'What is this rank?' });
    expect(trigger).toBeTruthy();
    // Hidden until interaction — no tooltip in the a11y tree at rest.
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('reveals the bubble on focus and links it via aria-describedby, then dismisses on Escape', () => {
    render(<InfoTip label="source" text="Refreshed automatically from its data source." />);
    const trigger = screen.getByRole('button', { name: 'source' });

    fireEvent.focus(trigger);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Refreshed automatically from its data source.');
    expect(trigger.getAttribute('aria-describedby')).toBe(tip.getAttribute('id'));
    // The WAI-ARIA tooltip pattern is role=tooltip + aria-describedby; it does
    // NOT use aria-expanded (that's a disclosure/button-controls-region attr).
    expect(trigger.getAttribute('aria-expanded')).toBeNull();

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows on hover and hides on mouse-leave', () => {
    render(<InfoTip label="info" text="Some help." />);
    const trigger = screen.getByRole('button', { name: 'info' });
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('tracks hover and focus independently — a mouse-leave does not dismiss a focus-opened tip', () => {
    render(<InfoTip label="info" text="Some help." />);
    const trigger = screen.getByRole('button', { name: 'info' });
    fireEvent.focus(trigger);
    fireEvent.mouseEnter(trigger);
    fireEvent.mouseLeave(trigger); // mouse gone, but the trigger is still focused
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
