/** UX-D3 — the DOM-derived TOC helpers: slug stability, dedupe, h4 cap, <2 empty. */
import { describe, expect, it } from 'vitest';
import { headingSlug, deriveToc } from '../docsToc.js';

describe('headingSlug', () => {
  it('slugifies deterministically, strips accents, bounds length', () => {
    expect(headingSlug('Getting Started!')).toBe('getting-started');
    expect(headingSlug('Configuração Avançada')).toBe('configuracao-avancada');
    expect(headingSlug('   ')).toBe('section');
    expect(headingSlug('x'.repeat(200)).length).toBeLessThanOrEqual(64);
  });
});

describe('deriveToc', () => {
  const container = (html: string): HTMLElement => {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  };

  it('extracts h1-h3 (h4 ignored), assigns deduped ids, needs ≥2 headings', () => {
    const el = container('<h2>Install</h2><p>x</p><h3>Install</h3><h4>Deep</h4><h2>Usage</h2>');
    const toc = deriveToc(el);
    expect(toc.map((e) => e.text)).toEqual(['Install', 'Install', 'Usage']);
    expect(toc[0]!.id).toBe('install');
    expect(toc[1]!.id).toBe('install-2'); // deduped
    expect(toc[1]!.level).toBe(3);
    expect(el.querySelector('h4')!.id).toBe(''); // capped at h3
  });

  it('returns [] under 2 headings (no lonely TOC)', () => {
    expect(deriveToc(container('<h2>Only</h2><p>x</p>'))).toEqual([]);
  });

  it('preserves pre-existing ids (idempotent re-derive)', () => {
    const el = container('<h2 id="custom">A</h2><h2>B</h2>');
    const first = deriveToc(el);
    expect(first[0]!.id).toBe('custom');
    expect(deriveToc(el)).toEqual(first); // second pass identical
  });
});
