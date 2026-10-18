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
 *
 * `getByText` IGNORES `aria-hidden`, so finding the label proves nothing about a
 * screen reader: every case also asserts the label is the `sr-only` span and sits
 * under NO `[aria-hidden]` ancestor (the product comment's warning — hiding the
 * wrapper hides the label with it), and that the visual glyph itself is hidden.
 * Sabotage-witnessed (/grade-tests w51 r2): `aria-hidden` on the true/undefined
 * wrapper, a swapped false label and a dropped undefined label each red a case.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { renderCapBoolGlyph } from '../CapabilitiesPanel.js';

afterEach(cleanup);

/** The label must be the sr-only text AND reachable by assistive tech. */
function announced(text: string): HTMLElement {
  const el = screen.getByText(text);
  expect(el.className).toBe('sr-only');
  expect(el.closest('[aria-hidden]'), `"${text}" sits under aria-hidden — a screen reader never hears it`).toBeNull();
  return el;
}

/** Text a screen reader reaches: every text node NOT under an aria-hidden ancestor. */
function accessibleText(root: HTMLElement): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let out = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest('[aria-hidden]')) out += n.textContent ?? '';
  }
  return out.trim();
}

describe('UX-GOV-4 — the tri-state reaches assistive tech', () => {
  it('TRUE announces "declared: supported"', () => {
    render(<>{renderCapBoolGlyph(true)}</>);
    announced('Declared: supported');
    expect(document.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true'); // the glyph is decoration
  });

  it('FALSE announces "declared: not supported" — not the same as true', () => {
    render(<>{renderCapBoolGlyph(false)}</>);
    announced('Declared: not supported');
    expect(screen.queryByText('Declared: supported')).toBeNull();
    expect(document.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('UNDEFINED announces "not declared" — distinct from declared-off', () => {
    render(<>{renderCapBoolGlyph(undefined)}</>);
    announced('Not declared by this host');
    expect(screen.queryByText('Declared: not supported')).toBeNull();
    expect(screen.getByText('—').getAttribute('aria-hidden')).toBe('true'); // the dash is not read out
  });

  it('all three states are mutually distinguishable to a text reader', () => {
    // The regression this pins: before the fix, two of these three rendered the
    // SAME accessible output (nothing at all). Counted over ACCESSIBLE text only —
    // the aria-hidden dash must not make "undefined" look announced.
    const labels = [true, false, undefined].map((v) => {
      cleanup();
      render(<>{renderCapBoolGlyph(v)}</>);
      return accessibleText(document.body);
    });
    expect(labels).toEqual(['Declared: supported', 'Declared: not supported', 'Not declared by this host']);
  });
});
