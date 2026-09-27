#!/usr/bin/env node
/**
 * `aria-label` / `aria-labelledby` on a role-less `<div>` or `<span>` is
 * PROHIBITED by ARIA — assistive tech IGNORES the attribute, so the element ends
 * up with no accessible name at all.
 *
 * This is the silent-a11y family this repo keeps re-fixing: the source looks
 * correct and reviews clean, and the defect is only visible at runtime to the
 * users least able to work around it. `check-notice-announce` and
 * `check-failure-card-announce` exist for the same reason.
 *
 * WHY A STATIC CHECK WHEN AXE ALREADY RUNS. The Playwright lane is now mandatory
 * in `npm run ci` (ADR 0509), and axe reports this rule — but **axe only flags
 * what it RENDERS**. The 9 sites this check was written for were all invisible
 * to it, purely because no spec happens to render them. A green a11y run was
 * false comfort for this class. A static scan sees unrendered code paths.
 *
 * WHY NOT ESLINT. `eslint-plugin-jsx-a11y` is installed and configured here, and
 * its `role-supports-aria-props` rule is the obvious candidate — but it was
 * measured against these exact sites and caught **zero** of them: it only
 * evaluates elements whose role it can resolve, and a bare `<div>` slips
 * through. Tested before writing this, rather than assumed.
 *
 * PARSES THE OPENING TAG, NOT THE LINE. A line-based grep reports
 * `<div className="field"><input aria-label=... /></div>` as a violation — the
 * label is on the INPUT, where it is perfectly legal. `KanbanBoardView.tsx` has
 * three of those. Matching per-line would have made this check cry wolf on its
 * first run, which is how a gate gets disabled.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

/** Elements whose implicit role (`generic`) does not support a name. */
const BARE = ['div', 'span'];

/** Walk `<tag` forward to the `>` that closes ITS opening tag, tracking JSX
 *  braces and quotes so a nested element or an expression cannot end it early. */
function readOpeningTag(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (c === '>' && depth === 0) return src.slice(start, i + 1);
    // A nested element started before this tag closed — malformed for our
    // purposes; bail rather than guess.
    if (c === '<' && i > start && depth === 0) return src.slice(start, i);
  }
  return null;
}

function scan(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const tag of BARE) {
    const needle = `<${tag}`;
    let idx = src.indexOf(needle);
    while (idx !== -1) {
      // `<divider`-style false start: the next char must end the tag name.
      const after = src[idx + needle.length];
      if (after && !/[\s>/]/.test(after)) { idx = src.indexOf(needle, idx + 1); continue; }
      const open = readOpeningTag(src, idx);
      // A SPREAD may supply the role — `{...attributes}` from dnd-kit spreads
      // role="button" onto the drag handle, and a static scan cannot see through
      // it. Reporting those would be crying wolf on correct code, which is how a
      // gate gets disabled. Measured: this exact case (KanbanBoardView's grip)
      // was the check's only false positive on first run, and tsc caught the
      // duplicate `role` my "fix" introduced.
      const hasSpread = open ? /\{\s*\.\.\./.test(open) : false;
      if (open && !hasSpread && /\saria-(label|labelledby)\s*=/.test(open) && !/\srole\s*=/.test(open)) {
        out.push({ kind: 'name', line: src.slice(0, idx).split('\n').length, tag, snippet: open.replace(/\s+/g, ' ').slice(0, 96) });
      }
      // DSA-020 (ADR 0510 Phase 1): a role-less div/span made focusable AND
      // click/keyboard-operable is a pseudo-control — AT users get a focus stop
      // with no role and (per the rule above) no reliable name. Use a native
      // <button>/<a>, or the stretched-button pattern when the container nests
      // controls (see WorkflowCardViews). Spread-carrying tags are exempt for
      // the same reason as above (dnd-kit spreads supply the role).
      if (open && !hasSpread && !/\srole\s*=/.test(open)
        && /\stabIndex\s*=/.test(open) && /\son(Click|KeyDown)\s*=/.test(open)) {
        out.push({ kind: 'pseudo', line: src.slice(0, idx).split('\n').length, tag, snippet: open.replace(/\s+/g, ' ').slice(0, 96) });
      }
      idx = src.indexOf(needle, idx + 1);
    }
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) { if (e !== '__tests__') walk(p, acc); }
    else if (e.endsWith('.tsx')) acc.push(p);
  }
  return acc;
}

const violations = [];
for (const f of walk(SRC)) {
  for (const v of scan(f)) violations.push({ file: relative(SRC, f), ...v });
}

if (violations.length > 0) {
  console.error(`\n✗ check-aria-prohibited: ${violations.length} violation(s).\n`);
  for (const v of violations) {
    console.error(`  src/${v.file}:${v.line}${v.kind === 'pseudo' ? '  (focusable click/keyboard pseudo-control without a role)' : ''}`);
    console.error(`    ${v.snippet}`);
  }
  console.error(`
  ARIA PROHIBITS a name on a <div>/<span> with no role — assistive tech IGNORES
  it, so the element has no accessible name at all. Pick by what the container IS:

    decorative (children already aria-hidden, or a parent announces)
        → DROP the label and add aria-hidden
    a labelled set of related items      → role="group"
    a landmark-worthy section            → role="region"  (or use <section>)
    navigation                           → use <nav>
    an elapsed/remaining time readout    → role="timer"
    a live status  → role="status", but ONLY if no live-region ancestor exists
                     (a nested live region is its own defect)

  If the children already state it in text, removing the label beats adding a role.
`);
  process.exit(1);
}
console.log('✓ check-aria-prohibited: no role-less element carries an ARIA name.');
