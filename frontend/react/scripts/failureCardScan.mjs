/**
 * The ONE definition of "a `<StateCard>` open tag" and "this card reports a
 * FAILURE", shared by `check-failure-card-announce.mjs` and
 * `check-failure-card-recovery.mjs` (ADR 0603 §7).
 *
 * EXTRACTED, not copied. The announce gate's own header records why: two gates
 * over one concept drift, and then neither is trustworthy — it folded its `-2`
 * sibling back in for exactly that reason. Adding a third hand-written copy of a
 * parser whose comment is three paragraphs of hard-won detail would have been the
 * same mistake with the same shape.
 */

/** Copy that marks a card as reporting a FAILURE rather than an empty result.
 *
 *  DETECTION IS BY COPY, and that is a known, deliberate false-negative class: a
 *  failure card whose title key avoids these words is invisible to BOTH gates. The
 *  alternative is inferring intent from surrounding render logic, which is not
 *  statically decidable and would produce a guard nobody trusts. */
export const FAILURE_COPY = /failed|unavailable|unknown|couldn|could not|cannot load|error/i;

/** Comments are not code — a sibling gate once shipped a whole false-positive class
 *  by forgetting this, reddening the build for a commit that FIXED the defect. */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const t = line.trimStart();
      if (t.startsWith('//') || t.startsWith('*')) return '';
      return line.replace(/(^|[^:])\/\/.*$/, '$1');
    })
    .join('\n');
}

/**
 * Slice each `<StateCard …>` OPEN TAG.
 *
 * Naively balancing `<` against `>` is wrong, and wrong in the worst way — it
 * truncates SILENTLY. `>` occurs constantly inside JSX props for reasons that have
 * nothing to do with closing a tag:
 *
 *     action={<button onClick={() => reload()}>Retry</button>}   the `=>` arrow
 *     title={t('a>b')}                                           inside a string
 *     title={n > 3 ? … : …}                                      a comparison
 *
 * The arrow case is not hypothetical or rare: a Retry button is the single most
 * likely prop on a FAILURE card, so the naive scan truncated exactly the elements
 * these gates exist to classify — 106 of 587 on the tree where this was written. It
 * happened to produce the right answer only because this codebase writes `title`
 * before `action`; a contributor using the other order would have created a card the
 * gates could never see. A count that is correct by accident of prop ordering is the
 * same confident-wrong number this whole programme is about.
 *
 * It matters DOUBLY for the recovery gate: the truncated tail is precisely where
 * `action` lives, so a naive scan there would report every card as a dead end.
 *
 * So: scan for the first `>` that is OUTSIDE a string and at brace-depth zero.
 * Expression containers `{…}` swallow arrows, comparisons and nested JSX alike,
 * which is precisely why depth-0 is the right test.
 */
export function elements(src) {
  const out = [];
  const re = /<StateCard\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let brace = 0;
    let quote = null;
    let j = m.index + m[0].length;
    for (; j < src.length; j += 1) {
      const c = src[j];
      if (quote) {
        if (c === '\\') j += 1;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') brace += 1;
      else if (c === '}') brace -= 1;
      else if (c === '>' && brace === 0) break;
    }
    // `L3` (ADR 0603 R1) — MAKE A DESYNC LOUD.
    //
    // The quote tracking above is right for props and wrong for JSX TEXT CHILDREN
    // nested inside an expression container: in `action={<Button>Don't stop</Button>}`
    // the apostrophe opens a "string" that never closes, so the scan runs to EOF and
    // returns a slice spanning the rest of the file. That direction is a silent FALSE
    // NEGATIVE for the recovery gate — the runaway slice swallows some LATER card's
    // `action=`, and the dead end it was supposed to find reports clean.
    //
    // Fixing the parser properly means distinguishing JSX children from expressions,
    // which is a real parse. Bounding it does not: no `<StateCard>` open tag in this
    // codebase is anywhere near this long, so a slice that hits the bound (or EOF)
    // means the scanner LOST TRACK, and a scanner that lost track must say so rather
    // than hand back a confident answer. MEASURED at the time of writing: 702
    // elements, 0 runaways.
    if (j >= src.length) {
      throw Object.assign(
        new Error(`failureCardScan: a <StateCard> open tag ran to end-of-file — the scanner lost track (likely an apostrophe in JSX text inside an expression container). Near: ${JSON.stringify(src.slice(m.index, m.index + 120))}`),
        { code: 'failure_card_scan_desync' },
      );
    }
    out.push(src.slice(m.index, j + 1));
  }
  return out;
}

/**
 * `L1` (ADR 0603 R1) — does this open tag offer a REAL way out?
 *
 * The recovery gate's original test was `/\baction=/`, which is a test for the
 * PROP, not for a recovery. `action={undefined}`, `action={null}` and
 * `action={canRetry && <Button …/>}` all pass it while rendering nothing — and the
 * last one is the shape a contributor is most likely to reach for, because it looks
 * conditional rather than inert. A gate that a dead end can satisfy by NAMING the
 * escape hatch is worse than no gate: it certifies the defect.
 *
 * So the action's own subtree must contain something a user can actuate. Kept
 * deliberately shallow — `<Button`, `<Link`, a bare `<button`, or an `onClick` —
 * because anything deeper is intent inference, which is the false-positive machine
 * `FAILURE_COPY`'s docblock already refuses one level up. The literal inert forms
 * are rejected by construction: none of them contains any of those tokens.
 *
 * The baseline is honest under this stricter rule because it was RE-MEASURED with
 * it (zero hits either way today, so the tightening moves no number and closes the
 * hole before anyone walks into it).
 */
export function hasRecoveryAction(el) {
  const at = el.search(/\baction=\{/);
  if (at === -1) return false;
  // Slice the expression container by brace depth — `action` values routinely
  // contain nested JSX and arrow functions, so a lazy `\{[^}]*\}` would truncate at
  // the first inner `}` and misread every non-trivial action.
  let brace = 0;
  let j = el.indexOf('{', at);
  const start = j;
  for (; j < el.length; j += 1) {
    if (el[j] === '{') brace += 1;
    else if (el[j] === '}') { brace -= 1; if (brace === 0) break; }
  }
  const value = el.slice(start, Math.min(j + 1, el.length));
  return /<Button\b|<Link\b|<button\b|onClick=/.test(value);
}
