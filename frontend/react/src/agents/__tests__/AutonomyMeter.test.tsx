import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AutonomyMeter } from '../AutonomyMeter.js';

afterEach(cleanup);

/** The gauge resolves its label + accessible name from the `agents` catalog
 *  (was hardcoded English before Phase A) and shows the level as filled-to-
 *  current dots (Phase B — free dots, no journey segment; the current dot is
 *  the emphasized one that carries the halo signature). */
describe('AutonomyMeter', () => {
  it('renders the localized label + role=img accessible name per level', () => {
    render(<AutonomyMeter autonomyLevel="review" />);
    const gauge = screen.getByRole('img');
    expect(gauge.getAttribute('aria-label')).toBe('Autonomy: Supervised');
    expect(screen.getByText('Supervised')).toBeTruthy();
  });

  it('fills one dot for review, two for guided, three for auto (done + current)', () => {
    const active = (level: 'review' | 'guided' | 'auto'): number => {
      const { container } = render(<AutonomyMeter autonomyLevel={level} />);
      const n = container.querySelectorAll('.auto-meter-dot--done, .auto-meter-dot--current').length;
      cleanup();
      return n;
    };
    expect(active('review')).toBe(1);
    expect(active('guided')).toBe(2);
    expect(active('auto')).toBe(3);
  });

  it('marks exactly one current dot, at the level index', () => {
    const { container } = render(<AutonomyMeter autonomyLevel="guided" />);
    const dots = Array.from(container.querySelectorAll('.auto-meter-dot'));
    expect(dots).toHaveLength(3);
    const current = container.querySelectorAll('.auto-meter-dot--current');
    expect(current).toHaveLength(1);
    // guided = level 2 → current is the 2nd dot (index 1)
    expect(dots.indexOf(current[0] as Element)).toBe(1);
  });

  it('defaults an absent level to Autonomous (three active dots)', () => {
    const { container } = render(<AutonomyMeter autonomyLevel={undefined} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Autonomy: Autonomous');
    expect(container.querySelectorAll('.auto-meter-dot--done, .auto-meter-dot--current').length).toBe(3);
  });

  it('hides the visible label when showLabel is false but keeps the accessible name', () => {
    render(<AutonomyMeter autonomyLevel="guided" showLabel={false} />);
    expect(screen.queryByText('Guided')).toBeNull();
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Autonomy: Guided');
  });
});
