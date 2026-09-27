/**
 * EPUB-DET-1 — EPUB/ODT export is byte-deterministic ACROSS A SECOND BOUNDARY.
 *
 * JSZip stamps every entry with `new Date()` at write time, so two exports from
 * identical inputs differed whenever they straddled a second. ADR 0400's own tests
 * assert "same inputs ⇒ identical bytes" and passed anyway — because both
 * generations normally land in the same second. The defect surfaced only when a
 * loaded full-suite run pushed them apart (`Buffer.compare` → -1, while the file
 * passed 21/21 in isolation).
 *
 * So the existing determinism tests are VACUOUS with respect to this bug: they
 * cannot fail on a fast machine. This one forces the gap, which is the whole point —
 * a determinism test that only runs quickly proves nothing about determinism.
 */

import { describe, expect, it } from 'vitest';

const MD = '# T\n\n$$\\frac{a}{b}$$ and text.\n\n- one\n- two\n';

describe('export determinism across a second boundary', () => {
  it('EPUB: two generations >1s apart are byte-identical', async () => {
    const { renderMarkdownToEpub } = await import('../src/features/documents/render.js');
    const opts = { title: 'D', identifier: 'urn:x:det', modifiedAt: '2026-07-17T00:00:00Z' };
    const a = await renderMarkdownToEpub(MD, opts);
    // The gap is the test. Without it this assertion cannot observe the defect.
    await new Promise((r) => setTimeout(r, 1100));
    const b = await renderMarkdownToEpub(MD, opts);
    expect(Buffer.compare(a, b), 'ZIP entry timestamps must be pinned, not `new Date()`').toBe(0);
  }, 20_000);

  it('ODT: two generations >1s apart are byte-identical', async () => {
    const { renderMarkdownToOdt } = await import('../src/features/documents/render.js');
    const a = await renderMarkdownToOdt(MD, { title: 'D' });
    await new Promise((r) => setTimeout(r, 1100));
    const b = await renderMarkdownToOdt(MD, { title: 'D' });
    // HONESTY NOTE: this passes with OR WITHOUT the pin — removing both pins leaves
    // only the EPUB assertion red. So ODT is already stable by some other property
    // and this is a regression guard, NOT evidence the pin does work here. Stated
    // rather than left to imply a verification that did not happen.
    expect(Buffer.compare(a, b), 'ODT carries no modifiedAt, so it pins to a stable epoch').toBe(0);
  }, 20_000);

  it('different CONTENT still produces different bytes — the fix must not flatten output', async () => {
    // Guards the opposite failure: pinning timestamps must not make every export
    // identical regardless of input.
    const { renderMarkdownToEpub } = await import('../src/features/documents/render.js');
    const opts = { title: 'D', identifier: 'urn:x:det', modifiedAt: '2026-07-17T00:00:00Z' };
    const a = await renderMarkdownToEpub('# One\n', opts);
    const b = await renderMarkdownToEpub('# Two\n', opts);
    expect(Buffer.compare(a, b)).not.toBe(0);
  }, 20_000);

  it('a different modifiedAt still changes the bytes — the pin tracks real input', async () => {
    // The pinned value is DERIVED from `modifiedAt`, not a hardcoded constant, so a
    // genuinely different document version remains distinguishable.
    const { renderMarkdownToEpub } = await import('../src/features/documents/render.js');
    const base = { title: 'D', identifier: 'urn:x:det' };
    const a = await renderMarkdownToEpub(MD, { ...base, modifiedAt: '2026-07-17T00:00:00Z' });
    const b = await renderMarkdownToEpub(MD, { ...base, modifiedAt: '2020-01-01T00:00:00Z' });
    expect(Buffer.compare(a, b)).not.toBe(0);
  }, 20_000);
});
