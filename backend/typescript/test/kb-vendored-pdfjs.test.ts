/**
 * H61 — the KB must not parse uploads with the pdf.js that unpdf VENDORS.
 *
 * `npm audit` reads the dependency graph. `unpdf` does not declare a dependency
 * on `pdfjs-dist`; it BUNDLES pdf.js into `dist/pdfjs.mjs` (unpdf 1.6.2 →
 * **5.6.205**, latest 1.8.1 → 6.1.200), inside GHSA-hq66-cqwq-w95j
 * (`>=5.6.83 <6.2.108`), and no unpdf release bundles a fixed one. That copy was
 * invisible to every audit until this file existed (2026-08-18).
 *
 * CORRECTED 2026-10-10: the debt was carried as an audit exception with a
 * time-box (revisitAfter 2026-10-14). It is now CLOSED instead: kbService's
 * `loadUnpdf()` hands unpdf the patched `pdfjs-dist` (direct, exact dependency)
 * through unpdf's `definePDFJSModule` seam, so the vendored copy is never
 * loaded. This file now pins that:
 *
 *   - the pdf.js unpdf RESOLVES through `loadUnpdf()` is outside the range
 *     (behavioural: it reads the loaded module's `version`, not a manifest);
 *   - no source file imports `unpdf` except `loadUnpdf()` (a second entry point
 *     that ran first would load the vendored copy);
 *   - while the vendored bundle is still vulnerable, the closed exception stays
 *     deleted (a stale exception is what `check-audit.mjs` exists to prevent);
 *   - `isEvalSupported: false` stays on the app's getDocumentProxy call.
 *
 * SABOTAGE-WITNESSED (2026-10-10): dropping the `definePDFJSModule` line reds
 * the resolved-version case (it reads 5.6.205).
 */

import { execFileSync } from 'node:child_process';
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

describe('H61 — the KB does not parse with the pdf.js unpdf vendors', () => {
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

  it('the KB parses with a fixed pdf.js, not the vendored copy', async () => {
    const { loadUnpdf } = await import('../src/features/kb/kbService.js');
    const unpdf = await loadUnpdf();
    const mod = (await unpdf.getResolvedPDFJS()) as { version?: string };
    const parts = String(mod.version ?? '').split('.').map(Number);
    expect(parts.length, `unpdf resolved no pdf.js version (${String(mod.version)})`).toBe(3);
    expect(
      cmp(parts, FIXED_AT) >= 0,
      `the KB's pdf.js is ${String(mod.version)}, inside GHSA-hq66-cqwq-w95j (<${FIXED_AT.join('.')}). ` +
        'loadUnpdf() must hand unpdf the patched pdfjs-dist via definePDFJSModule.',
    ).toBe(true);
  }, 60_000);

  it('no source file imports unpdf except loadUnpdf()', () => {
    const hits = execFileSync('git', ['grep', '-nE', "(from|import\\() *'unpdf'", '--', 'src'], { cwd: BACKEND, encoding: 'utf8' })
      .split('\n').filter(Boolean)
      // `typeof import('unpdf')` is a type and loads nothing; every other form does.
      .filter((h) => h.replace(/typeof import\('unpdf'\)/g, '').includes("'unpdf'"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^src\/features\/kb\/kbService\.ts:\d+:\s+const unpdf = await import\('unpdf'\);/);
  });

  it('while the vendored bundle is vulnerable, its closed exception stays deleted', () => {
    const entry = exceptions.find((e) => e.package === VENDORED_KEY);
    expect(
      entry,
      `the "${VENDORED_KEY}" exception was closed 2026-10-10 (the KB no longer loads the vendored copy). ` +
        'If you are re-adding it, the KB is parsing with the vendored pdf.js again: fix loadUnpdf() instead.',
    ).toBeUndefined();
  });

  it('keeps `isEvalSupported: false` on the app-controlled getDocumentProxy call', () => {
    // ADR 0904 P2 — the call moved to the per-page parser; kbService hands it the proxy
    // factory from `loadUnpdf()` (asserted below), so the patched pdf.js is still the one.
    const src = readFileSync(join(BACKEND, 'src', 'features', 'kb', 'parsers', 'pdfPages.ts'), 'utf8');
    const kb = readFileSync(join(BACKEND, 'src', 'features', 'kb', 'kbService.ts'), 'utf8');
    expect(kb, 'the PDF lane must take its pdf.js from loadUnpdf()').toContain('extractPdfPages(await loadUnpdf(), buffer)');
    // Deliberately NOT a paren-balanced match: the first draft used a lazy
    // `\(([\s\S]*?)\)` and stopped at the `)` inside `new Uint8Array(buffer)`,
    // so it read the ARGUMENT rather than the call. A fixed window after the
    // call site is cruder and cannot be fooled that way.
    const at = src.indexOf('getDocumentProxy(');
    expect(at, 'parsers/pdfPages.ts no longer calls getDocumentProxy — re-point this assertion').toBeGreaterThan(-1);
    const call = src.slice(at, at + 200);
    expect(
      call,
      'the KB PDF path must disable pdf.js string-eval: it parses authenticated user uploads, ' +
        'and the flag defaults to TRUE.',
    ).toContain('isEvalSupported: false');
  });
});
