/**
 * ONE comment-stripper for source-text ratchets.
 *
 * WHY THIS FILE EXISTS. A ratchet that greps source text for a call — "does
 * this file pass `derivedFromRun: true`?" — reads a DOCBLOCK that names the
 * call as if it were the call. That is not hypothetical: the ADR 0604 H1 fix
 * writes a 20-line comment explaining `derivedFromRun`, and the first draft of
 * `run-metadata-copy-sites.test.ts` stayed GREEN under sabotage because the
 * prose still matched after the argument was deleted. A green sabotage is a
 * finding about the instrument.
 *
 * The repo already had ~10 hand-written copies of this two-line regex, each
 * subtly different. New source-text ratchets import THIS one; the existing
 * copies are left alone (rewriting ten unrelated suites is a bigger change than
 * the defect warrants) but should migrate here when they are next touched.
 *
 * Block comments first, then line comments — the line-comment arm is guarded
 * against `://` inside a URL/string literal, which is the classic false strip.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}
