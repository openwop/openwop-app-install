/**
 * ADR 1096 — public-site style tokens. Pins the contract an adopter relies on:
 * every token is declared `initial` at :root (so nothing changes until a brand
 * sets it), every use carries a fallback equal to the stock look, and the
 * surfaces the ADR names actually read them. Sabotage: give a token a real
 * default at :root, drop a fallback, or hard-code a card radius again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (...p: string[]): string => readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf8');
const css = read('styles', 'global.css') + '\n' + read('features', 'cms', 'designSections.css');
const TOKENS = ['shell-max', 'section-pad', 'section-rule', 'card-bg', 'card-border', 'card-radius', 'card-shadow', 'card-raise-shadow', 'card-raise-lift', 'media-radius', 'hero-image-opacity', 'hero-image-mask'].map((t) => `--site-${t}`);

describe('ADR 1096 site style tokens', () => {
  it('declares every token as initial, so the stock look is unchanged', () => {
    for (const t of TOKENS) expect(css, t).toMatch(new RegExp(`${t}: initial;`));
  });
  it('gives every use a fallback', () => {
    const uses = [...css.matchAll(/var\((--site-[a-z-]+)(\s*,)?/g)];
    expect(uses.length).toBeGreaterThan(20);
    for (const [, name, comma] of uses) expect(comma, `${name ?? ''} without a fallback`).toBeTruthy();
  });
  it('reads the tokens on the surfaces the ADR names', () => {
    for (const [selector, token] of [
      ['.fp-shell {', '--site-shell-max'], ['.fp-section {', '--site-section-pad'], ['.fp-faq__item {', '--site-card-radius'],
      ['.fp-cols--plans .fp-col {', '--site-card-bg'], ['.fp-formcard__card {', '--site-card-shadow'], ['.fp-gallery__shot .fp-shot__img {', '--site-media-radius'],
      ['.fp-rtcard {', '--site-card-radius'],
    ] as const) {
      const at = css.indexOf(selector);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      expect(css.slice(at, css.indexOf('}', at)), selector).toContain(token);
    }
    expect(css).toContain('mask-image: var(--site-hero-image-mask,');
  });
});
