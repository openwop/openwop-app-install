/**
 * ADR 0362 / CV-13 — the bar's quick-prop cluster: the quick filter (boolean
 * + options-bearing defs, 3-cap), toggle semantics (false stores as ABSENT —
 * the locked-checkbox precedent), and the enum menu write path.
 *
 * (w46: the ADR 0362 Phase 4 "tree-catalog quick props" case was cut — it
 * re-implemented the chassis branch inside the test and re-exercised only this
 * filter; w46g2-qp-options reds the quickDefs case above for the same break.)
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QuickPropsCluster, quickDefs } from '../QuickPropsCluster.js';
import type { CanvasPropDef } from '../types.js';

const tt = (k: string, o?: { defaultValue: string }): string => o?.defaultValue ?? k;

describe('quickDefs (ADR 0362)', () => {
  it('keeps quick booleans + options-bearing defs (custom enum widget types qualify); drops the rest', () => {
    // The UNMARKED def comes FIRST: placed last it fell beyond the 3-cap, so
    // dropping the `quick === true` filter could not show (w46g2-qp-quickflag).
    const defs: CanvasPropDef[] = [
      { name: 'stage', type: 'enum-required', options: ['a'] }, // unmarked → dropped
      { name: 'build', type: 'boolean', quick: true },
      { name: 'notes', type: 'longtext', quick: true },   // no bar control → dropped
      { name: 'variant', type: 'slide-enum', options: ['full', 'hero'], quick: true },
      { name: 'width', type: 'number', quick: true },     // v2: renders as a compact number field
    ];
    expect(quickDefs(defs).map((d) => d.name)).toEqual(['build', 'variant', 'width']);
  });

  it('caps at the bar budget with a dev warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const many: CanvasPropDef[] = Array.from({ length: 5 }, (_, i) => ({ name: `b${i}`, type: 'boolean', quick: true }));
    try {
      // Literal, not QUICK_MAX: an expectation imported from the product moves
      // with a sabotage of it (w46g2-qp-capconst).
      expect(quickDefs(many).map((d) => d.name)).toEqual(['b0', 'b1', 'b2']);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('QuickPropsCluster', () => {
  it('boolean toggles write true / ABSENT and reflect state via aria-pressed', () => {
    const onSet = vi.fn();
    const defs: CanvasPropDef[] = [{ name: 'build', type: 'boolean', label: 'Build', quick: true }];
    const { rerender } = render(<QuickPropsCluster defs={defs} valueOf={() => undefined} onSet={onSet} tt={tt} label="Quick formatting" />);
    const btn = screen.getByRole('button', { name: 'Build' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(onSet).toHaveBeenCalledWith('build', true);
    rerender(<QuickPropsCluster defs={defs} valueOf={() => true} onSet={onSet} tt={tt} label="Quick formatting" />);
    expect(screen.getByRole('button', { name: 'Build' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Build' }));
    expect(onSet).toHaveBeenLastCalledWith('build', undefined); // false = absent
  });

  it('enum menus show the current value and write the picked option', () => {
    const onSet = vi.fn();
    const defs: CanvasPropDef[] = [{ name: 'variant', type: 'slide-enum', label: 'Variant', options: ['full', 'hero'], default: 'full', quick: true }];
    render(<QuickPropsCluster defs={defs} valueOf={() => 'hero'} onSet={onSet} tt={tt} label="Quick formatting" />);
    const trigger = screen.getByRole('button', { name: 'Variant' });
    expect(trigger.textContent).toContain('hero');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'full' }));
    expect(onSet).toHaveBeenCalledWith('variant', 'full');
  });
});

describe('QuickPropsCluster v2 (number + color)', () => {
  it('number drafts locally and commits ONE clamped write on blur', () => {
    const onSet = vi.fn();
    const defs: CanvasPropDef[] = [{ name: 'strokeWidth', type: 'number', label: 'Stroke width', min: 0, max: 100, quick: true }];
    render(<QuickPropsCluster defs={defs} valueOf={() => 2} onSet={onSet} tt={tt} label="Quick formatting" />);
    const input = screen.getByRole('spinbutton', { name: 'Stroke width' });
    fireEvent.change(input, { target: { value: '999' } });
    expect(onSet).not.toHaveBeenCalled(); // drafting — no per-keystroke history
    fireEvent.blur(input);
    expect(onSet).toHaveBeenCalledWith('strokeWidth', 100); // clamped to max
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it('color renders a labeled native input writing the picked hex', () => {
    const onSet = vi.fn();
    const defs: CanvasPropDef[] = [{ name: 'fill', type: 'color', label: 'Fill', quick: true }];
    render(<QuickPropsCluster defs={defs} valueOf={() => '#112233'} onSet={onSet} tt={tt} label="Quick formatting" />);
    const input = screen.getByLabelText('Fill') as HTMLInputElement;
    expect(input.value).toBe('#112233');
    fireEvent.change(input, { target: { value: '#445566' } });
    expect(onSet).toHaveBeenCalledWith('fill', '#445566');
  });
});
