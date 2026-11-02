/**
 * EPUB-DET-1 — EPUB/ODT export is byte-deterministic ACROSS A SECOND BOUNDARY
 * (TST-DBD-1).
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
 *
 * HOW the gap is forced (CORRECTED in w70): this used to sleep a real 1.1 s
 * between generations. Zip entries store DOS time at 2-SECOND resolution, so a
 * 1.1 s gap landed in the same 2 s bucket about half the time — the witness was a
 * coin flip, and the ODT case "passed without the pin" for that reason, not
 * because of some other property. Now only `Date` is faked and the two
 * generations are stamped 10 s apart: deterministic, and 2.2 s cheaper.
 *
 * Red when: the EPUB pin (`pinZipTimestamps(zip, modified)`) or the ODT pin
 * (`pinZipTimestamps(zip, '1970-…')`) is dropped, or the pinned date stops being
 * derived from `modifiedAt` (probes w70g2-exp-epub-pin-r2 / -exp-odt-pin-r2 /
 * -exp-derived-r2).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { renderMarkdownToEpub, renderMarkdownToOdt } from '../src/features/documents/render.js';

const MD = '# T\n\n$$\\frac{a}{b}$$ and text.\n\n- one\n- two\n';
const T0 = new Date('2026-07-17T10:00:00Z');
const T1 = new Date('2026-07-17T10:00:10Z'); // 10 s later: always a different DOS 2 s bucket

/** Render twice with the wall clock 10 s apart (only `Date` is faked). */
async function twice(render: () => Promise<Buffer>): Promise<[Buffer, Buffer]> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const a = await render();
  vi.setSystemTime(T1);
  const b = await render();
  vi.useRealTimers();
  return [a, b];
}

afterEach(() => { vi.useRealTimers(); });

describe('export determinism across a second boundary', () => {
  it('EPUB: two generations >1s apart are byte-identical', async () => {
    const opts = { title: 'D', identifier: 'urn:x:det', modifiedAt: '2026-07-17T00:00:00Z' };
    const [a, b] = await twice(() => renderMarkdownToEpub(MD, opts));
    expect(Buffer.compare(a, b), 'ZIP entry timestamps must be pinned, not `new Date()`').toBe(0);
  });

  it('ODT: two generations >1s apart are byte-identical', async () => {
    const [a, b] = await twice(() => renderMarkdownToOdt(MD, { title: 'D' }));
    expect(Buffer.compare(a, b), 'ODT carries no modifiedAt, so it pins to a stable epoch').toBe(0);
  });

  it('different CONTENT still produces different bytes — the fix must not flatten output', async () => {
    // Guards the opposite failure: pinning timestamps must not make every export
    // identical regardless of input.
    const opts = { title: 'D', identifier: 'urn:x:det', modifiedAt: '2026-07-17T00:00:00Z' };
    const a = await renderMarkdownToEpub('# One\n', opts);
    const b = await renderMarkdownToEpub('# Two\n', opts);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('a different modifiedAt still changes the bytes — the pin tracks real input', async () => {
    // The pinned entry date is DERIVED from `modifiedAt`, not a hardcoded constant.
    // Asserted on the zip ENTRY date itself: the bytes would differ anyway through
    // the OPF's `dcterms:modified` text, so a byte comparison alone could not see a
    // hard-coded pin (round-1 probe w70g2-exp-derived was vacuous for that reason).
    const base = { title: 'D', identifier: 'urn:x:det' };
    const a = await renderMarkdownToEpub(MD, { ...base, modifiedAt: '2026-07-17T00:00:00Z' });
    const b = await renderMarkdownToEpub(MD, { ...base, modifiedAt: '2020-01-01T00:00:00Z' });
    expect(Buffer.compare(a, b)).not.toBe(0);
    const dateOf = async (buf: Buffer): Promise<number | undefined> => (await JSZip.loadAsync(buf)).files['mimetype']?.date.getTime();
    expect(await dateOf(a)).toBe(Date.parse('2026-07-17T00:00:00Z'));
    expect(await dateOf(b)).toBe(Date.parse('2020-01-01T00:00:00Z'));
  });
});
