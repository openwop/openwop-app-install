/**
 * PriorityMeter (portfolio design pass) — the ranking meter's fill must be
 * proportional to value/max, clamp to [0,1], survive max=0 (an all-zero view
 * must not divide by zero), and mute the zero value's ink.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PriorityMeter } from '../PriorityMatrixPage.js';

afterEach(cleanup);

const fillWidth = (): string => {
  const fill = screen.getByTestId('pm-meter-fill');
  return (fill as HTMLElement).style.width;
};

describe('PriorityMeter', () => {
  it('fills proportionally to value/max', () => {
    render(<PriorityMeter value={4.15} max={8.3} />);
    expect(fillWidth()).toBe('50%');
  });

  it('fills 100% at the max and renders the value', () => {
    render(<PriorityMeter value={8.3} max={8.3} />);
    expect(fillWidth()).toBe('100%');
    expect(screen.getByText('8.3')).toBeTruthy();
  });

  it('renders an empty track and muted ink for a zero value', () => {
    render(<PriorityMeter value={0} max={8.3} />);
    expect(fillWidth()).toBe('0%');
    expect(screen.getByText('0').className).toContain('pm-meter__value--zero');
  });

  it('survives max=0 without dividing by zero', () => {
    render(<PriorityMeter value={0} max={0} />);
    expect(fillWidth()).toBe('0%');
  });

  it('clamps a value above max to 100%', () => {
    render(<PriorityMeter value={12} max={8.3} />);
    expect(fillWidth()).toBe('100%');
  });
});
