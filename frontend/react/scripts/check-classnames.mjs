#!/usr/bin/env node
/**
 * Classname-existence gate (UX-ASSESSMENT DS-5).
 *
 * An undefined utility class silently no-ops — the JSX reads as styled while
 * nothing applies. This has shipped real bugs three separate ways: `u-sr-only`
 * (a no-op alias of `.sr-only`, so "hidden" labels rendered visibly) and the
 * task-deck `u-ml-3`/`u-pad-2` (the delegation hierarchy rendered flat). The
 * CSS-token gate can't catch this class of slip — it validates `var()` refs,
 * not selectors.
 *
 * Scope is deliberately conservative to stay false-positive-free: only tokens
 * that are unambiguously class vocabulary — the `u-*` utility family plus the
 * screen-reader utilities (`sr-only`, `visually-hidden`) — extracted from
 * string/template literals in src TSX/TS. Everything else (semantic classes,
 * dynamic names) is out of scope.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CSS_FILES = ['src/styles/foundations/tokens.css', 'src/styles/global.css', 'src/styles/chrome/admin.css', 'src/styles/primitives/adr0510.css', 'src/brand/brand.css'];
const TOKEN_RE = /^(u-[a-z0-9-]+|sr-only|visually-hidden)$/;
// String/template literal contents (good enough for class tokens — we only
// need the whitespace-separated words inside them).
const LITERAL_RE = /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\]*)`/g;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(p);
  }
  return out;
}

const css = CSS_FILES.map((f) => readFileSync(f, 'utf8')).join('\n');
// A definition must be the class ON ITS OWN — at the start of a selector or after a
// `,`/`{`/`}` — not buried inside a descendant selector.
//
// THE HOLE THIS CLOSES, measured 2026-09-17. The old pattern matched `.u-…` ANYWHERE
// in the CSS, so `.mkt-review-head > .u-text-muted { flex; font-size }` registered
// `u-text-muted` as defined. It was used in 96 files and set NO COLOUR in any of them:
// every author believed they were muting text and none were. This gate reported green
// throughout, because a compound-scoped rule is indistinguishable from a utility under
// a substring match — a gate that could not fail for the one failure mode its own
// docblock names ("an undefined utility class silently no-ops").
//
// Measured before tightening: `u-text-muted` was the ONLY compound-only class in `src/`,
// so this bites exactly the real defect and nothing else. It is defined properly in the
// same commit.
const defined = new Set(
  [...css.matchAll(/(^|[,{}])\s*\.((?:u-[a-z0-9-]+|sr-only|visually-hidden))(?![a-z0-9-])/gm)].map((m) => m[2]),
);

const missing = new Map(); // token -> [file:line]
for (const file of walk('src', [])) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let inBlock = false;
  lines.forEach((rawLine, i) => {
    // Strip line + block comments — a backtick inside prose (e.g. a doc
    // comment naming `u-sr-only`) must not parse as a template literal. Line-
    // based state tracking is enough here; we only need class tokens, so a
    // `/*` inside a string (vanishingly rare in this codebase) at worst skips
    // a line, never false-positives.
    let line = rawLine;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    let start;
    while ((start = line.indexOf('/*')) !== -1) {
      const end = line.indexOf('*/', start + 2);
      if (end === -1) { line = line.slice(0, start); inBlock = true; break; }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    line = line.split('//')[0];
    for (const m of line.matchAll(LITERAL_RE)) {
      const body = m[1] ?? m[2] ?? m[3] ?? '';
      for (const word of body.split(/\s+/)) {
        if (TOKEN_RE.test(word) && !defined.has(word)) {
          if (!missing.has(word)) missing.set(word, []);
          missing.get(word).push(`${file}:${i + 1}`);
        }
      }
    }
  });
}

if (missing.size > 0) {
  console.error('✗ check-classnames: class tokens used in src but defined in no stylesheet (they silently no-op):');
  for (const [token, sites] of missing) {
    console.error(`  .${token} — ${sites.slice(0, 5).join(', ')}${sites.length > 5 ? ` (+${sites.length - 5} more)` : ''}`);
  }
  console.error('  Define the class in global.css/brand.css or fix the token (e.g. `u-sr-only` → `sr-only`).');
  process.exit(1);
}
console.log(`✓ check-classnames: all u-*/sr-only class tokens in src resolve (${defined.size} defined).`);
