/**
 * ONE comment-stripper for source-text ratchets. Use it for `.ts` and `.mjs`.
 *
 * WHY THIS FILE EXISTS. A ratchet that greps source text for a call — "does
 * this file pass `derivedFromRun: true`?" — reads a DOCBLOCK that names the
 * call as if it were the call. That is not hypothetical: the ADR 0604 H1 fix
 * writes a 20-line comment explaining `derivedFromRun`, and the first draft of
 * `run-metadata-copy-sites.test.ts` stayed GREEN under sabotage because the
 * prose still matched after the argument was deleted. A green sabotage is a
 * finding about the instrument.
 *
 * WHY THE SCANNER (#5422). Every regex form of this removes live code. A `/*`
 * in a `//` comment or in a string opens a "block" that runs to the next `*\/`,
 * so the code between them leaves the scan and the ratchet goes silently blind.
 * MEASURED on 2,472 files in `src` and `packs`: the regex lost 7,076 identifiers
 * in 25 files (1,948 in `routes/testSeam.ts`). This scanner lost 0 and removed
 * all 78,421 comments checked, in about a second for the whole tree.
 *
 * A comment becomes one space plus its own newlines, so tokens stay apart and
 * line numbers stay true. Strings, templates and regex literals are copied.
 *
 * Not for `.tsx`: JSX text is not tokens, so an apostrophe in it reads as a
 * string. The scan keeps that code, but may keep a comment on the same line.
 */
import ts from 'typescript';

const { SyntaxKind: K } = ts;

/** Whether a `/` after this token divides rather than opening a regex. */
function endsExpression(k: ts.SyntaxKind): boolean {
  return k === K.Identifier || k === K.NumericLiteral || k === K.BigIntLiteral || k === K.StringLiteral
    || k === K.RegularExpressionLiteral || k === K.NoSubstitutionTemplateLiteral || k === K.TemplateTail
    || k === K.CloseParenToken || k === K.CloseBracketToken || k === K.CloseBraceToken
    || k === K.ThisKeyword || k === K.SuperKeyword || k === K.TrueKeyword || k === K.FalseKeyword || k === K.NullKeyword
    || k === K.PlusPlusToken || k === K.MinusMinusToken
    || (k >= K.AbstractKeyword && k <= K.OfKeyword);
}

export function stripComments(src: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, src);
  // One open-brace count per `${`, so a `}` can close its template hole.
  const holes: number[] = [];
  let out = '';
  let prev: ts.SyntaxKind = K.Unknown;
  for (;;) {
    let k = scanner.scan();
    if (k === K.EndOfFileToken) return out;
    if (k === K.SingleLineCommentTrivia || k === K.MultiLineCommentTrivia) {
      out += ` ${scanner.getTokenText().replace(/[^\n]/g, '')}`;
      continue;
    }
    if ((k === K.SlashToken || k === K.SlashEqualsToken) && !endsExpression(prev)) k = scanner.reScanSlashToken();
    if (k === K.TemplateHead) {
      holes.push(0);
    } else if (k === K.OpenBraceToken && holes.length > 0) {
      holes[holes.length - 1]! += 1;
    } else if (k === K.CloseBraceToken && holes.length > 0) {
      if (holes[holes.length - 1] === 0) {
        k = scanner.reScanTemplateToken(false);
        if (k === K.TemplateTail) holes.pop();
      } else {
        holes[holes.length - 1]! -= 1;
      }
    }
    out += scanner.getTokenText();
    if (k !== K.WhitespaceTrivia && k !== K.NewLineTrivia) prev = k;
  }
}
