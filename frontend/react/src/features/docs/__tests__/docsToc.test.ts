/**
 * UX-D3 / R2R-1 — the DOM-derived docs TOC (`docs/docsToc.ts`, ADR 0392 public docs
 * tier): h1–h3 only (h4 capped), ids slugified and DEDUPED — including two headings
 * that arrive with the SAME pre-assigned id (R2R-1: the shared renderer stamps
 * section ids, so duplicates are real) — pre-existing ids kept, and no TOC under
 * two headings.
 *
 * The slug algorithm itself (`cms/headingSlug.ts`, re-exported here) is pinned by
 * `cms/__tests__/headingSlug.test.tsx` "headingSlug (shared algorithm)" — its
 * backend-parity cases — and is not re-tested here (/grade-tests w52 cut the copy).
 *
 * Sabotage-witnessed (/grade-tests w52): adding h4 to the selector, dropping the
 * dedupe suffix, `>= 1` for the two-heading floor, ignoring `h.id`, and a flat
 * level each turn one case red.
 */
import { describe, expect, it } from 'vitest';
import { deriveToc } from '../docsToc.js';

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
    expect(toc.map((e) => e.id)).toEqual(['install', 'install-2', 'usage']); // deduped
    expect(toc.map((e) => e.level)).toEqual([2, 3, 2]);
    expect(el.querySelector('h4')!.id).toBe(''); // capped at h3
  });

  it('dedupes two headings that arrive with the SAME pre-assigned id (R2R-1)', () => {
    const el = container('<h2 id="faq">Pricing</h2><h2 id="faq">Billing</h2><h2 id="faq">Refunds</h2>');
    expect(deriveToc(el).map((e) => e.id)).toEqual(['faq', 'faq-2', 'faq-3']);
    expect(Array.from(el.querySelectorAll('h2')).map((h) => h.id)).toEqual(['faq', 'faq-2', 'faq-3']);
  });

  it('returns [] under 2 headings (no lonely TOC)', () => {
    expect(deriveToc(container('<h2>Only</h2><p>x</p>'))).toEqual([]);
  });

  it('preserves pre-existing ids (idempotent re-derive)', () => {
    const el = container('<h2 id="custom">A</h2><h2>B</h2>');
    const first = deriveToc(el);
    expect(first.map((e) => e.id)).toEqual(['custom', 'b']);
    expect(deriveToc(el)).toEqual(first); // second pass identical
  });
});
