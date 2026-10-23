/**
 * ADR 0916 (Book AI P13 + P17) — two brand hooks with unchanged defaults:
 * `--rule-control` (a field's boundary) and `--ink-muted-recess` (muted text on
 * the recess fill). Red under: a field rule that reads `--rule` directly again,
 * a hook WITHOUT its fallback (an unset brand would render no border), or the
 * More-contrast mode not lifting them (a property present but set to a value that
 * does not lift, e.g. `var(--paper-2)`, reds too: the values are pinned).
 * Ceiling: jsdom resolves neither custom-property fallbacks nor media queries, so
 * the declaration text IS the claim. Sabotage-witnessed: w55g1-bh-* (round 1),
 * w55g1-bh-*-r2 (round 2).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../global.css'), 'utf8');
const rule = (selector: string): string => {
  const i = css.indexOf(`${selector} {`);
  expect(i, selector).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
};

describe('brand hook tokens (ADR 0916)', () => {
  it('text fields take their border from --rule-control, falling back to --rule', () => {
    expect(rule('input, textarea, select')).toMatch(/border:\s*1px solid var\(--rule-control, var\(--rule\)\)/);
  });

  it('muted chips and bare captions on the recess fill use --ink-muted-recess, falling back to --ink-3', () => {
    expect(css).toMatch(/^\.chip--muted\s*\{[^}]*color:\s*var\(--ink-muted-recess, var\(--ink-3\)\)/m);
    expect(rule('.surface-inset label:not([class])')).toContain('var(--ink-muted-recess, var(--ink-3))');
  });

  it('More-contrast mode lifts both hooks, in both the override and the media query', () => {
    // Lifted = the field rule moves to --ink-3 and the recess caption to --ink-2, the same
    // stronger steps the mode gives --rule and --ink-3 themselves.
    const more = rule(':root[data-contrast="more"]');
    expect(more).toMatch(/--rule-control:\s*var\(--ink-3\);/);
    expect(more).toMatch(/--ink-muted-recess:\s*var\(--ink-2\);/);
    const at = css.indexOf('@media (prefers-contrast: more)');
    expect(at).toBeGreaterThan(-1);
    const mq = css.slice(at, css.indexOf('}', css.indexOf('{', at) + 1));
    expect(mq).toMatch(/--rule-control:\s*var\(--ink-3\);/);
    expect(mq).toMatch(/--ink-muted-recess:\s*var\(--ink-2\);/);
  });
});
