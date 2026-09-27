/**
 * H61 — a VENDORED copy of a vulnerable dependency must not be invisible.
 *
 * `npm audit` reads the dependency graph. `unpdf` does not declare a dependency
 * on `pdfjs-dist`; it BUNDLES pdf.js into `dist/pdfjs.mjs`. So the KB's primary
 * PDF path can sit inside an advisory range while every audit, every exception
 * file and every CI gate reports clean — which is exactly what was happening
 * when this test was written: unpdf@1.6.2 bundles pdf.js **5.6.205**, and
 * GHSA-hq66-cqwq-w95j covers `>=5.6.83 <6.2.108`.
 *
 * The advisory IS reported for the second PDF path (officeparser →
 * `pdfjs-dist`), so `scripts/audit-exceptions.json` already carries it. Nothing
 * connected that record to the copy npm cannot see. This test does, and fails
 * closed in both directions:
 *
 *   - bundled pdf.js below the fixed version, with no exception entry naming
 *     the vendored copy -> RED
 *   - bundled pdf.js at or above the fixed version, with the entry still
 *     present -> RED (delete the entry; a stale exception is the failure mode
 *     `check-audit.mjs` exists to prevent)
 *
 * It also pins the one mitigation the app controls on this call site
 * (`isEvalSupported: false`), because that flag is a single word that a future
 * refactor of `extractTextFromBytes` would drop without any other signal.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BACKEND = join(__dirname, '..');
const ROOT = join(BACKEND, '..', '..');

/** First pdf.js release outside GHSA-hq66-cqwq-w95j's range (`>=5.6.83 <6.2.108`). */
const FIXED_AT = [6, 2, 108] as const;
/** The `package` value the exception entry must use for the vendored copy. */
const VENDORED_KEY = 'unpdf-vendored-pdfjs';

const cmp = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

describe('H61 — the pdf.js that unpdf vendors is accounted for', () => {
  const bundlePath = join(BACKEND, 'node_modules', 'unpdf', 'dist', 'pdfjs.mjs');

  const bundled = (() => {
    // VACUITY GUARD. If the bundle moves or the marker changes, this test must
    // FAIL rather than quietly stop checking — an unreadable tripwire and a
    // clean tree are indistinguishable, and that is the defect class this file
    // belongs to.
    let text: string;
    try {
      text = readFileSync(bundlePath, 'utf8');
    } catch {
      throw new Error(
        `H61 tripwire cannot read ${bundlePath}. unpdf's layout changed, or deps are not installed. ` +
          'Re-point this test at the new bundle — do not delete it: the vendored copy is invisible to `npm audit`.',
      );
    }
    const m = /apiVersion\s*:\s*"(\d+)\.(\d+)\.(\d+)"/.exec(text);
    if (!m) {
      throw new Error(
        'H61 tripwire found no `apiVersion` marker in unpdf\'s bundled pdf.js. ' +
          'Find the new version marker and re-point this test.',
      );
    }
    return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  })();

  const exceptions = (() => {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'scripts', 'audit-exceptions.json'), 'utf8')) as {
      exceptions: Array<Record<string, unknown>>;
    };
    return cfg.exceptions ?? [];
  })();

  it('reads a version out of the vendored bundle at all', () => {
    expect(bundled.every((n) => Number.isInteger(n))).toBe(true);
  });

  it('is either fixed upstream, or recorded as a debt with a live time-box', () => {
    const entry = exceptions.find((e) => e.package === VENDORED_KEY);
    const version = bundled.join('.');

    if (cmp(bundled, FIXED_AT) >= 0) {
      // Upstream caught up. The record must go — `check-audit.mjs` cannot see
      // this one to mark it stale, so the removal is asserted here instead.
      expect(
        entry,
        `unpdf now bundles pdf.js ${version} (>= ${FIXED_AT.join('.')}), so the ` +
          `"${VENDORED_KEY}" exception is stale — delete it from scripts/audit-exceptions.json.`,
      ).toBeUndefined();
      return;
    }

    expect(
      entry,
      `unpdf bundles pdf.js ${version}, inside GHSA-hq66-cqwq-w95j (>=5.6.83 <6.2.108), and ` +
        '`npm audit` cannot see it because unpdf declares no pdfjs-dist dependency. ' +
        `Add a "${VENDORED_KEY}" entry to scripts/audit-exceptions.json (same required fields as ` +
        'every other entry) so the debt is visible where reviewers look.',
    ).toBeDefined();

    // The time-box has to be live, or the record is decoration.
    const revisitAfter = String(entry?.revisitAfter ?? '');
    expect(revisitAfter, `"${VENDORED_KEY}" needs an ISO revisitAfter date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      revisitAfter >= new Date().toISOString().slice(0, 10),
      `the "${VENDORED_KEY}" exception expired on ${revisitAfter} — re-make the call, do not move the date.`,
    ).toBe(true);
  });

  it('keeps `isEvalSupported: false` on the app-controlled getDocumentProxy call', () => {
    const src = readFileSync(join(BACKEND, 'src', 'features', 'kb', 'kbService.ts'), 'utf8');
    // Deliberately NOT a paren-balanced match: the first draft used a lazy
    // `\(([\s\S]*?)\)` and stopped at the `)` inside `new Uint8Array(buffer)`,
    // so it read the ARGUMENT rather than the call. A fixed window after the
    // call site is cruder and cannot be fooled that way.
    const at = src.indexOf('getDocumentProxy(');
    expect(at, 'kbService no longer calls getDocumentProxy — re-point this assertion').toBeGreaterThan(-1);
    const call = src.slice(at, at + 200);
    expect(
      call,
      'the KB PDF path must disable pdf.js string-eval: it parses authenticated user uploads, ' +
        'and the flag defaults to TRUE.',
    ).toContain('isEvalSupported: false');
  });
});
