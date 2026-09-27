/**
 * UX_UPGRADE-governance P4 — a distinction preserved in the data must reach the
 * user, including via assistive tech.
 *
 * `boolGlyph`'s comment states the invariant precisely: "`undefined` means the
 * host hasn't declared the field; that's distinct from `false` (declared off)."
 * The DATA kept all three states. The SURFACE threw two of them away:
 * `CheckIcon` / `CircleIcon` render `aria-hidden`, and the wrapping spans carried
 * only a colour class. To a screen reader `true` announced NOTHING, `false`
 * announced NOTHING, and `undefined` announced "—" — so true and false were
 * indistinguishable from each other AND from an empty cell, and the very
 * distinction the function exists to make was invisible.
 *
 * It is also the app's OWN rule, already written down on the ops console:
 * "pass/fail is a WORD in the chip, never color alone (WCAG 1.4.1)".
 *
 * This is the same class as the rest of this programme — a surface failing to
 * convey something the code knows — expressed as accessibility rather than read
 * honesty.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { renderCapBoolGlyph } from '../CapabilitiesPanel.js';

afterEach(cleanup);

describe('UX-GOV-4 — the tri-state reaches assistive tech', () => {
  it('TRUE announces "declared: supported"', () => {
    render(<>{renderCapBoolGlyph(true)}</>);
    expect(screen.getByText('Declared: supported')).toBeTruthy();
  });

  it('FALSE announces "declared: not supported" — not the same as true', () => {
    render(<>{renderCapBoolGlyph(false)}</>);
    expect(screen.getByText('Declared: not supported')).toBeTruthy();
    expect(screen.queryByText('Declared: supported')).toBeNull();
  });

  it('UNDEFINED announces "not declared" — distinct from declared-off', () => {
    render(<>{renderCapBoolGlyph(undefined)}</>);
    expect(screen.getByText('Not declared by this host')).toBeTruthy();
    expect(screen.queryByText('Declared: not supported')).toBeNull();
  });

  it('all three states are mutually distinguishable to a text reader', () => {
    // The regression this pins: before the fix, two of these three rendered the
    // SAME accessible output (nothing at all).
    const labels = [true, false, undefined].map((v) => {
      cleanup();
      render(<>{renderCapBoolGlyph(v)}</>);
      return document.body.textContent ?? '';
    });
    expect(new Set(labels).size).toBe(3);
  });
});
