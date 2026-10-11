/**
 * EPUB-DET-1 — the test that can actually FAIL when the export stops being
 * byte-deterministic.
 *
 * The fix (`pinZipTimestamps`, `features/documents/render.ts`) shipped
 * UNPROTECTED. `documents-export.test.ts` already carries two tests named
 * "is deterministic (same inputs ⇒ identical bytes)", and MEASURED 2026-09-01:
 * deleting BOTH `pinZipTimestamps` calls leaves all 21 of them passing.
 * (CORRECTED w14 grade-tests: the math-present one of those two was CUT as
 * redundant — "EPUB: identical inputs a day apart" below uses math input too,
 * and the same content-randomness sabotage, `w14g2-det-epub-random` /
 * `w14g2-exp-epub-random`, turned both red. The per-version one remains,
 * because it also carries images.)
 *
 * Sabotage-witnessed (w14): removing the EPUB pin reds cases 1, 3, 4; removing
 * the ODT pin reds case 2; pinning to a constant reds cases 3 and 4.
 *
 * They cannot fail because of HOW the defect works. JSZip stamps each entry with
 * `new Date()` at write time, so two generations differ only when they straddle a
 * second boundary. Back-to-back calls in one test almost always land in the same
 * second, so the assertion holds for the wrong reason — which is exactly how the
 * original defect survived long enough to surface as a full-suite "flake"
 * (`expected -1 to be +0`, passing 21/21 in isolation).
 *
 * A test whose subject is a TIMESTAMP must therefore control the clock. This one
 * moves the system clock a full day between the two generations: with the fix,
 * every entry carries the pinned `modifiedAt` (or the epoch, for ODT) and the
 * bytes match; without it, every entry carries a wall-clock stamp a day apart and
 * they cannot.
 *
 * Note this asserts a property the OTHER tests only name. It is deliberately a
 * separate file: the existing ones are still worth keeping (they cover content),
 * and renaming them would hide that their determinism claim was vacuous.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { renderMarkdownToEpub, renderMarkdownToOdt } from '../src/features/documents/render.js';

const MD = '# Title\n\nA paragraph with $$E = mc^2$$ math and a list:\n\n- one\n- two\n';
/** Two instants a full day apart — far wider than the second boundary that
 *  actually triggers this, so the test cannot be timing-marginal. */
const T1 = Date.UTC(2026, 5, 1, 12, 0, 0);
const T2 = Date.UTC(2026, 5, 2, 12, 0, 0);

afterEach(() => { vi.useRealTimers(); });

/** Generate once at each instant, with identical inputs. */
async function twiceAcrossTheClock(gen: () => Promise<Buffer>): Promise<[Buffer, Buffer]> {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(T1);
  const a = await gen();
  vi.setSystemTime(T2);
  const b = await gen();
  vi.useRealTimers();
  return [a, b];
}

describe('EPUB-DET-1 — export bytes do not depend on WHEN they were generated', () => {
  it('EPUB: identical inputs a day apart produce identical bytes', async () => {
    const opts = { title: 'D', identifier: 'urn:x:9', modifiedAt: '2026-07-17T00:00:00Z' };
    const [a, b] = await twiceAcrossTheClock(() => renderMarkdownToEpub(MD, opts));
    expect(Buffer.compare(a, b), 'the wall clock leaked into the archive').toBe(0);
  });

  it('ODT: identical inputs a day apart produce identical bytes', async () => {
    const [a, b] = await twiceAcrossTheClock(() => renderMarkdownToOdt(MD, { title: 'D' }));
    expect(Buffer.compare(a, b), 'the wall clock leaked into the archive').toBe(0);
  });

  it('EPUB entry timestamps carry the PINNED modifiedAt, not the generation time', async () => {
    // The load-bearing negative: byte-equality alone would also be satisfied by
    // pinning to a constant that ignores `modifiedAt`, which would silently
    // discard a real modification time. Assert the stamp is the SUPPLIED one.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(T1);
    const buf = await renderMarkdownToEpub(MD, { title: 'D', identifier: 'urn:x:9', modifiedAt: '2026-07-17T00:00:00Z' });
    vi.useRealTimers();

    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    expect(names.length, 'no entries — the assertion below would be vacuous').toBeGreaterThan(3);
    for (const name of names) {
      expect(zip.files[name].date.toISOString(), `entry '${name}' kept a generation-time stamp`)
        .toBe('2026-07-17T00:00:00.000Z');
    }
  });

  it('a DIFFERENT modifiedAt moves the ENTRY STAMPS, not merely the bytes', async () => {
    // First draft of this test compared BYTES and claimed it proved "the pin is
    // not a constant". It did not: `modifiedAt` also lands in the OPF metadata
    // (`dcterms:modified`), so the bytes differ under a hard-coded pin too — it
    // passed under the exact sabotage it existed to catch. Compare the archive
    // ENTRY DATES, which only the pin can move.
    const base = { title: 'D', identifier: 'urn:x:9' };
    const stamps = async (modifiedAt: string): Promise<string[]> => {
      const zip = await JSZip.loadAsync(await renderMarkdownToEpub(MD, { ...base, modifiedAt }));
      return Object.keys(zip.files).sort().map((n) => zip.files[n].date.toISOString());
    };
    const a = await stamps('2026-07-17T00:00:00Z');
    const b = await stamps('2026-08-17T00:00:00Z');
    expect(a.length, 'no entries — vacuous').toBeGreaterThan(3);
    expect(a, 'modifiedAt is not reaching the entry stamps — the pin is a constant').not.toEqual(b);
  });
});
