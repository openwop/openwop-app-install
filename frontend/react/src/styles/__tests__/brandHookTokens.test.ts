/**
 * ADR 0916 (Book AI P13 + P17) — two brand hooks with unchanged defaults:
 * `--rule-control` (a field's boundary) and `--ink-muted-recess` (muted text on
 * the recess fill). Red under: a field rule that reads `--rule` directly again,
 * a hook WITHOUT its fallback (an unset brand would render no border), or the
 * More-contrast mode not lifting them.
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
    expect(css).toMatch(/\.chip--muted\s*\{[^}]*color:\s*var\(--ink-muted-recess, var\(--ink-3\)\)/);
    expect(rule('.surface-inset label:not([class])')).toContain('var(--ink-muted-recess, var(--ink-3))');
  });

  it('More-contrast mode lifts both hooks, in both the override and the media query', () => {
    const more = rule(':root[data-contrast="more"]');
    expect(more).toContain('--rule-control:');
    expect(more).toContain('--ink-muted-recess:');
    const at = css.indexOf('@media (prefers-contrast: more)');
    const mq = css.slice(at, css.indexOf('}', css.indexOf('{', at) + 1));
    expect(mq).toContain('--rule-control:');
    expect(mq).toContain('--ink-muted-recess:');
  });
});
