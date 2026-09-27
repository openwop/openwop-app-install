#!/usr/bin/env node
/**
 * Unwrapped-action-button RATCHET (ADR 0510 §4, DSA-013).
 *
 * TWO COUNTS, because one was a promise this corpus cannot keep. The gate used
 * to say the bare-`button` element rule survives "until this count reaches
 * ZERO" — but of the sites left after the bulk tranches, ~95% are BESPOKE
 * controls (`chip`, `list-row-id`, `msgbubble-action-btn`, `welcome-card`,
 * `fp-btn`, the row-as-link idiom) that must NEVER become `<Button variant>`:
 * wrapping them would assert an intent their CSS does not have. Zero was
 * therefore unreachable by migration, so the stated exit could never fire and
 * the number stopped meaning anything.
 *
 *   VARIANT-BEARING — a raw button carrying the variant vocabulary (or no
 *     className at all, since bare IS primary). These are migration debt and
 *     ratchet to ZERO. This is the count whose exit flips the element rule.
 *   BESPOKE — everything else. Shrink-only: it may fall as families grow their
 *     own primitives, and must never grow. Not migration debt.
 *
 * WHAT THE VARIANT SCAN CANNOT SEE: it reads string literals INSIDE the tag,
 * so `<button className={cls}>` with `cls` computed above the JSX is invisible
 * to it (`ui/Menu.tsx` takes its class from a prop; 14 call sites pass the
 * variant vocabulary into it). Those are bespoke today, so the count is honest
 * — but read `variant-bearing: 0` as "no LITERAL variant class remains", not
 * as a proof about every rendered button. (An AST does not change this: it
 * still does not RESOLVE identifiers, deliberately — chasing a value across
 * files is a type-checker's job, and a wrong guess here would be worse than a
 * stated blind spot.)
 *
 * Reaching variant-bearing ZERO is NOT by itself licence to flip the element
 * rule to reset-only: the bespoke families must first be audited for whether
 * they lean on the bare-`button` baseline for padding/border. That audit is the
 * remaining gate, and it is a separate piece of work.
 *
 * `ui/Button` is the explicit intent API; new code uses `<Button variant=…>`.
 *
 * Not counted: `ui/Button.tsx` itself (the one legitimate raw site),
 * `ui/IconButton.tsx` (its own primitive), and test files (fixtures).
 *
 * DSYS-2 (2026-08-16): the scan is a real TypeScript AST walk — `<button>`
 * elements and their `className` attributes are the compiler's own nodes, so
 * comments and strings can no longer confuse the count. This RETIRES the
 * prev-char-aware `stripComments` scanner and its documented residual
 * (`const s = ' /* x'` could still fool it): the parser's comment handling is
 * exact. The historical lesson it encoded — six `<button>` sites inside PROSE
 * once taxed this ledger, and a naive string-unaware stripper later swallowed
 * 348 lines of live code across 6 spans via `accept="audio/*,video/*"` — is
 * kept here because it is WHY the gate now parses instead of stripping.
 * Verified count-identical at cutover (250 raw / 0 variant-bearing).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { readGateBaseline } from './gateBaseline.mjs';

const SRC = process.env.OPENWOP_GATE_SRC
  ? join(process.env.OPENWOP_GATE_SRC, '/')
  : new URL('../src/', import.meta.url).pathname;
// 238 → 244 (2026-08-07, UX_UPGRADE-site round 2): six new BESPOKE `.fp-btn`
// sites on the public surface — four failure-state Retry buttons (blog index,
// blog post, /p/:slug, pricing — the failed-read-honesty program) and the two
// pricing billing-period toggle segments. All are fp-system chrome the docblock
// above says must NEVER become `<Button variant>`; a deliberate raise, not drift.
// 244 → 247 (2026-08-08, UX_UPGRADE-forms round 2): three more bespoke `.fp-btn`
// controls on the PUBLIC fill renderer — the load-failed Retry, "Submit another
// response", and the resume "Start over". Same fp-system lane, same rationale.
// 247 → 248 (2026-08-08, UX_UPGRADE-funnels round 2): the funnel viewer's
// load-failed Retry — the same public fp-system failure-state control.
// 248 → 249 (2026-08-08, UX_UPGRADE-crm-public round 2): the month-grid day
// CELL (`.booking-month__day--on`, BookingMonthGrid.tsx) — a calendar cell
// with its own grid chrome and aria-pressed state; wrapping it in
// `<Button variant>` would assert intent its CSS does not have.
// 249 → 250 (2026-08-15, ADR 0565): the selection-rewrite verb toolbar
// (SelectionRewrite.tsx) — three `msgbubble-action-btn` buttons, the exact
// bespoke family the docblock above names as must-NEVER-wrap. A deliberate
// raise, not drift.
// 250 → 251 (2026-08-18, ADR 0584 / FORM-UX-4): the funnel step's "Continue to
// the next step" EXIT, shown when that step's form is unavailable. Same public
// fp-system lane as the 247→248 raise directly above (the funnel viewer's own
// load-failed Retry) and rendered beside it. It exists because a funnel advances
// ONLY via the form's submit, so a step whose form is deleted, unpublished or
// toggled off was a dead end with no way out — the gate-with-no-exit shape.
// A deliberate raise, not drift.
const BASELINE = readGateBaseline('check-unwrapped-buttons', 'OPENWOP_UNWRAPPED_BUTTONS_BASELINE', 249);
/** Migration debt. Ratchets to ZERO; its exit is the element-rule flip. */
const VARIANT_BASELINE = readGateBaseline('check-unwrapped-buttons', 'OPENWOP_VARIANT_BUTTONS_BASELINE', 0);
/** The variant vocabulary a raw button can carry. Bare (no className) counts too. */
const VARIANT_TOKENS = new Set(['secondary', 'ghost', 'btn-ghost', 'btn-sm', 'btn-link',
  'btn-accent', 'btn-accent-solid', 'btn', 'btn-primary', 'primary', 'u-text-danger']);
const EXEMPT = new Set(['ui/Button.tsx', 'ui/IconButton.tsx']);

const walk = (dir, acc = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') walk(p, acc); }
    else if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) acc.push(p);
  }
  return acc;
};

/** Every literal class token reachable inside a className initializer:
 *  string literals, and the LITERAL text chunks of template literals (the
 *  `${…}` holes are separate expression nodes and simply aren't literals). */
function literalTokens(node, toks) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    for (const t of node.text.split(/\s+/)) if (t) toks.add(t);
  } else if (ts.isTemplateExpression(node)) {
    for (const t of node.head.text.split(/\s+/)) if (t) toks.add(t);
    for (const span of node.templateSpans) {
      literalTokens(span.expression, toks);
      for (const t of span.literal.text.split(/\s+/)) if (t) toks.add(t);
    }
  } else {
    ts.forEachChild(node, (c) => literalTokens(c, toks));
  }
}

// Anti-vacuity (the check-failure-card-announce precedent): a broken SRC or
// walk yields an empty file list, and an empty scan must read as a BROKEN
// GATE, never as a clean bill.
const files = walk(SRC);
if (files.length === 0) {
  console.error(`✗ ${process.argv[1]?.split('/').pop()}: the walk found ZERO ${'%s'} — the gate is broken, not the code clean.`.replace('%s', 'tsx files'));
  process.exit(1);
}

let count = 0;
let variantCount = 0;
const variantSites = [];
const perFile = [];
for (const f of files) {
  const rel = relative(SRC, f);
  if (EXEMPT.has(rel)) continue;
  const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let n = 0;
  const visit = (node) => {
    const isOpen = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
    if (isOpen && ts.isIdentifier(node.tagName) && node.tagName.text === 'button') {
      n += 1;
      const classAttr = node.attributes.properties.find(
        (a) => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === 'className',
      );
      const toks = new Set();
      if (classAttr?.initializer) {
        if (ts.isStringLiteral(classAttr.initializer)) {
          for (const t of classAttr.initializer.text.split(/\s+/)) if (t) toks.add(t);
        } else if (ts.isJsxExpression(classAttr.initializer) && classAttr.initializer.expression) {
          literalTokens(classAttr.initializer.expression, toks);
        }
      }
      const bare = !classAttr;
      if (bare || [...toks].some((t) => VARIANT_TOKENS.has(t))) {
        variantCount += 1;
        variantSites.push(rel);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (n) { count += n; perFile.push([rel, n]); }
}

if (count > BASELINE) {
  perFile.sort((a, b) => b[1] - a[1]);
  console.error(`✗ check-unwrapped-buttons: ${count} raw <button> sites (baseline ${BASELINE}). You ADDED ${count - BASELINE}.`);
  console.error('  New actions use <Button variant=…> (ui/Button.tsx). Top holders:');
  for (const [f, n] of perFile.slice(0, 8)) console.error(`    ${f}: ${n}`);
  process.exit(1);
}
if (variantCount > VARIANT_BASELINE) {
  console.error(`✗ check-unwrapped-buttons: ${variantCount} raw <button> sites still carry the VARIANT vocabulary (baseline ${VARIANT_BASELINE}).`);
  console.error('  These are migration debt, not bespoke chrome — use <Button variant=…>.');
  for (const s of [...new Set(variantSites)].slice(0, 10)) console.error(`    ${s}`);
  process.exit(1);
}
const note = count < BASELINE ? ` — down ${BASELINE - count}; lower BASELINE to ${count}.` : '';
const vnote = variantCount === 0
  ? ' · variant-bearing: 0 LITERAL (indirected classNames are invisible to this scan — see the header)'
  : ` · variant-bearing: ${variantCount} (baseline ${VARIANT_BASELINE})`;
console.log(`✓ check-unwrapped-buttons: ${count} raw <button> sites (baseline ${BASELINE}, ratchet holds).${note}${vnote}`);
