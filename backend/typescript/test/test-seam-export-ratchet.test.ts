/**
 * ADR 0734 — a test-only export with no reader is dead code in the shipped tree.
 *
 * `__resetFoo` / `_fooForTest` / `fooForTesting` exports exist so a test can clear
 * module-level state. When the test that used one is deleted or rewritten, the helper
 * survives as an exported symbol nothing calls — and because the white-label bundle is a
 * `git archive` of the whole tree, it ships to every adopter as apparent API.
 *
 * This ratchet fails when a test-shaped export in `src/` has no reader anywhere. It lives
 * in the SHIPPED test lane, not `test/steward/`: it reads only `src/`, so it reads nothing
 * the bundle strips, and the invariant is one adopters should keep enforcing on their fork.
 * Putting it under `test/steward/` would strip it out and silently exempt all of them.
 *
 * The unit of judgement is the SEAM, not the spelling. When this reds, the fix is not
 * automatically "delete the helper":
 *   - the seam is dead (its registrar has no callers either) → delete the WHOLE seam;
 *   - the seam is live and a test dirties it → WIRE the helper into that test's teardown;
 *   - the seam is live in production and untouched by tests → delete the helper alone.
 * ADR 0734 records why: the first sweep's own proposal would have deleted the repo's only
 * timer-teardown seam while six test files left its 20-second interval running.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist' && entry !== 'lib') walk(p, out);
    } else if (/\.(ts|mjs|js)$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * The SPELLING SET — ONE leading underscore, not two.
 *
 * This regex has now been widened twice by measurement, which is the argument for
 * measuring rather than asserting coverage. It began as `__*` only; review found the
 * `ForTest(?:s|ing)` suffix was mandatory rather than optional, so a bare singular
 * `clearConfigDomainsForTest` was invisible. Then a sweep of declared test seams found
 * **43 single-underscore exports** the `__` rule could not see — `_resetHostSurfaceRegistry`,
 * `_resetMcpRouterCaches`, `_resetEnvelopeAcceptorCaches`, `_resetRateLimitState`,
 * `_resetOidcVerifier`, `_resetBreakGlassAttempts` and the rest. Every one of the 43 is a
 * test seam by name; none is plausible public API. A single leading underscore IS this
 * repo's "not API" marker, so the rule keys on that rather than on a doubled one.
 *
 * NOT keyed on the docblock saying "test seam": that was tried and over-matches badly —
 * a 6-line context window attributed neighbouring prose to 53 symbols including plain
 * types like `Principal` and `VmExecResult`. False positives here red an innocent build.
 */
const TEST_SEAM_DECL =
  /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+(_[A-Za-z0-9_]*|[A-Za-z0-9_]*ForTest(?:s|ing)?)\b/;

// Measured on the ADR 0734 sweep commit. Floors sit on the DENOMINATOR: a glob that stops
// matching, or a detector that stops recognising the shape, must red rather than pass an
// empty assertion. (The `workflow-pin-site-ratchet.test.ts:646` idiom.)
const MIN_SRC_FILES = 1650; // measured 1741
const MIN_TEST_SEAM_EXPORTS = 300; // measured 321 once the single-underscore spelling was included

describe('ADR 0734 — every test-only export in src/ has a reader', () => {
  const srcFiles = walk(SRC);
  const searchFiles = [...srcFiles, ...walk(join(ROOT, 'test')), ...walk(join(ROOT, '..', '..', 'scripts'))]
    // THIS file names swept symbols in its own prose. Counting that as a reader would let
    // any dead symbol stay alive by being mentioned here — the first draft's negative
    // control caught exactly that, which is the argument for having a negative control.
    .filter((f) => f !== __filename);

  // A mention in a COMMENT is not a reader. The repo has been burned by ratchets that
  // counted commented-out code as live; a docblock saying "we used to call __resetFoo"
  // must not hold __resetFoo alive. Strings are left intact (a string-keyed registry IS
  // a real reference), and the `:` guard keeps `https://…` from eating the rest of a line.
  const stripComments = (t: string): string =>
    t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const texts = new Map(searchFiles.map((f) => [f, stripComments(readFileSync(f, 'utf8'))]));

  // Keyed by `file#symbol`, NOT by symbol. A `Map<symbol, file>` silently collapses
  // every duplicate name to one entry: `__test` is declared in 11 src files, so 300
  // declaration lines became 290 map entries and TEN declarations were never inspected.
  // Worse, the other ten declaration LINES each counted as a reader of the survivor, so
  // a genuinely dead `__test` was certified live. Caught by review sabotage.
  const decls = new Map<string, { sym: string; file: string }>();
  const declaringFiles = new Map<string, Set<string>>();
  for (const f of srcFiles) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = TEST_SEAM_DECL.exec(line);
      if (!m) continue;
      const sym = m[1]!;
      decls.set(`${relative(ROOT, f)}#${sym}`, { sym, file: f });
      if (!declaringFiles.has(sym)) declaringFiles.set(sym, new Set());
      declaringFiles.get(sym)!.add(f);
    }
  }

  // A reader is a file that mentions the symbol and does NOT itself declare it. Excluding
  // only the one declaring file lets a sibling declaration stand in for a real consumer.
  //
  // For a name declared in ONE place a word match is sufficient and catches every form of
  // reference, including string-keyed ones. For a name declared in SEVERAL places it is
  // not: `__test` is imported by many test files, so a word match says "referenced" for
  // all 11 declarations even when a given one is dead. Those need the reference resolved
  // to a MODULE, which means reading the import specifier.
  const importsOf = (text: string, sym: string): string[] =>
    [...text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)]
      .filter(([, names]) => names!.split(',').some((n) => n.trim().split(/\s+as\s+/)[0]!.trim() === sym))
      .map(([, , spec]) => spec!);

  const referenced = (sym: string, declFile: string): boolean => {
    const declarers = declaringFiles.get(sym) ?? new Set([declFile]);
    const re = new RegExp(`\\b${sym}\\b`);
    for (const [f, t] of texts) {
      if (declarers.has(f) || f === declFile) continue;
      if (!re.test(t)) continue;
      if (declarers.size === 1) return true; // unambiguous: any mention is a reference
      // Ambiguous name — the mention only counts if it is imported from THIS module.
      for (const spec of importsOf(t, sym)) {
        if (!spec.startsWith('.')) continue;
        const resolved = resolve(dirname(f), spec).replace(/\.js$/, '.ts');
        if (resolved === declFile) return true;
      }
    }
    return false;
  };

  it('the detector is looking at something (denominator floors)', () => {
    expect(srcFiles.length).toBeGreaterThanOrEqual(MIN_SRC_FILES);
    expect(decls.size).toBeGreaterThanOrEqual(MIN_TEST_SEAM_EXPORTS);
  });

  it('positive control — a widely-imported seam is classified as REFERENCED', () => {
    // Without this, a reference side stuck returning `true` would make the ratchet below
    // vacuously green forever. `__resetGovernanceStore` is imported by 12 test files.
    const entry = [...decls.values()].find((d) => d.sym === '__resetGovernanceStore');
    expect(entry).toBeDefined();
    expect(referenced(entry!.sym, entry!.file)).toBe(true);
  });

  it('a DUPLICATED declaration name cannot be held alive by its own siblings', () => {
    // `__test` is declared in 11 src files. Every one must be inspected on its own, and
    // a sibling declaration must not count as a reader. This is the review sabotage:
    // appending a dead `export const __test` used to leave the ratchet 4/4 green.
    const testEntries = [...decls.keys()].filter((k) => k.endsWith('#__test'));
    expect(testEntries.length).toBeGreaterThanOrEqual(11);
    // And each must be judged on its OWN importers, not on the name's popularity.
    const goals = [...decls.values()].find((d) => d.sym === '__test' && d.file.endsWith('goalsService.ts'));
    expect(goals).toBeDefined();
    expect(referenced(goals!.sym, goals!.file)).toBe(true); // really imported from goalsService
  });

  it('negative control — a symbol that does not exist is classified as UNREFERENCED', () => {
    // Built at runtime so the literal never appears in this file's own bytes.
    const absent = ['__', 'absent', 'Seam', Date.now().toString(36)].join('');
    expect(referenced(absent, '')).toBe(false);
  });

  it('no test-only export in src/ is unreferenced', () => {
    const orphans = [...decls]
      .filter(([, d]) => !referenced(d.sym, d.file))
      .map(([key]) => key)
      .sort();
    expect(orphans).toEqual([]);
  });
});
