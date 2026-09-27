#!/usr/bin/env node
/**
 * Feature-prefix class↔selector gate (ADR 0378 P5).
 *
 * The #1905 bug class: a rename (or refactor) changes a component's emitted
 * classNames while the stylesheet keeps the old selectors — every rule
 * silently orphans and the surface ships UNSTYLED. No other gate can see it:
 * `check-classnames` validates only the `u-*`/sr utility vocabulary,
 * `check-css-tokens` validates `var()` refs, `check-built-css` empty `:is()`.
 *
 * Scope is deliberately conservative (false-positive-free): only class tokens
 * carrying a REGISTERED feature prefix are checked, in both directions —
 *  - FAIL: a TSX-emitted prefixed token with no matching stylesheet selector
 *    (the orphaned-component direction — the surface renders unstyled);
 *  - WARN: a stylesheet selector with a registered prefix that no TSX emits
 *    (dead-rule direction — advisory only, dynamic class construction makes
 *    this legitimately fuzzy).
 * Template-literal tokens truncated by `${…}` match by prefix (a token must
 * equal a defined class OR be a prefix of one).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CSS_FILES = ['src/styles/foundations/tokens.css', 'src/styles/global.css', 'src/styles/chrome/admin.css', 'src/styles/primitives/adr0510.css', 'src/brand/brand.css'];
/** Feature class-prefixes under the gate. Add a prefix when a feature grows a
 *  prefixed CSS family — the gate then owns its rename safety. */
const PREFIXES = ['walkthrough-', 'notifpanel-', 'netpanel-', 'btn-'];
const LITERAL_RE = /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\]*)`/g;
/** Known prefixed NON-class string values (wire ids etc.) — never selectors.
 *  'walkthrough-step' is the interrupt KIND (a persisted wire value). */
const NON_CLASS_TOKENS = new Set(['walkthrough-step', 'tour-step']);

function walk(dir, out) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === '__tests__' || name.name === 'node_modules') continue;
    const p = join(dir, name.name);
    if (name.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name.name)) out.push(p);
  }
  return out;
}

// 1. Collect defined class selectors for the registered prefixes.
const defined = new Set();
for (const f of CSS_FILES) {
  // COMMENTS ARE NOT CODE. `global.css:1082` says "there is deliberately NO
  // .primary/.btn-primary class" — scanning raw text counted that PROSE as a
  // definition, so a genuinely dead class read as defined. Same lesson
  // check-failed-read-sentinels.mjs documents for its own scan.
  const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/\.([a-z][a-z0-9-]*)/g)) {
    if (PREFIXES.some((p) => m[1].startsWith(p))) defined.add(m[1]);
  }
}

// 2. Collect prefixed tokens emitted by TSX/TS source. A token is TRUNCATED
// (prefix-matchable) ONLY when it ends exactly at a template interpolation
// boundary (`foo--${state}` → 'foo--'); every other token must match a
// defined class EXACTLY — the old blanket prefix-acceptance let a typo that
// happens to prefix an unrelated real class ship unstyled (the very #1905
// class this gate exists to catch).
const emitted = new Map(); // token -> { file, truncated }
function record(tok, file, truncated) {
  const clean = truncated ? tok.replace(/-+$/, '') : tok;
  if (!clean || NON_CLASS_TOKENS.has(clean) || !PREFIXES.some((p) => clean.startsWith(p))) return;
  const prev = emitted.get(clean);
  // MERGE evidence: the same base token can appear both as an exact class AND
  // as a template-truncated stem in one expression (`item item--${state}`) —
  // truncated evidence must survive for the dead-rule direction.
  if (!prev) emitted.set(clean, { file, truncated });
  else prev.truncated = prev.truncated || truncated;
}
for (const f of walk('src', [])) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(LITERAL_RE)) {
    const isTemplate = m[3] !== undefined;
    const body = m[1] ?? m[2] ?? m[3] ?? '';
    if (!isTemplate) {
      for (const raw of body.split(/\s+/)) record(raw, f, false);
    } else {
      // Quoted strings INSIDE interpolations (ternary modifiers like
      // `${x ? ' foo--top' : ''}`) are exact class evidence — the template
      // regex swallows them, so scan the interpolation content explicitly.
      for (const im of body.matchAll(/\$\{[^}]*\}/g)) {
        for (const qm of im[0].matchAll(/'([^']*)'|"([^"]*)"/g)) {
          for (const raw of (qm[1] ?? qm[2] ?? '').split(/\s+/)) record(raw, f, false);
        }
      }
      // split into segments around ${...}; a segment's LAST token is truncated
      // iff an interpolation followed it.
      const segments = body.split(/\$\{[^}]*\}/);
      segments.forEach((seg, i) => {
        const toks = seg.split(/\s+/).filter(Boolean);
        toks.forEach((raw, j) => {
          const truncated = i < segments.length - 1 && j === toks.length - 1 && !/\s$/.test(seg);
          record(raw, f, truncated);
        });
      });
    }
  }
}

// 3. FAIL direction: exact tokens need an exact class; truncated tokens may
// prefix-match (the interpolation completes them at runtime).
const orphans = [];
for (const [tok, { file, truncated }] of emitted) {
  const ok = defined.has(tok) || (truncated && [...defined].some((d) => d.startsWith(tok)));
  if (!ok) orphans.push({ tok, file });
}

// 4. WARN direction: defined class no emitted token equals/prefixes.
const dead = [...defined].filter((d) => ![...emitted.entries()].some(([t, meta]) => d === t || (meta.truncated && d.startsWith(t))));

if (dead.length > 0) {
  console.warn(`⚠ check-orphan-classes: ${dead.length} prefixed CSS class(es) with no TSX emitter (dead rules? advisory):`);
  for (const d of dead.slice(0, 10)) console.warn(`  .${d}`);
}
if (orphans.length > 0) {
  console.error(`✗ check-orphan-classes: ${orphans.length} emitted class(es) with NO stylesheet selector — the surface ships unstyled (the #1905 bug class):`);
  for (const { tok, file } of orphans) console.error(`  ${file} → "${tok}"`);
  process.exit(1);
}
console.log(`✓ check-orphan-classes: ${emitted.size} prefixed class token(s) all resolve to stylesheet selectors (${PREFIXES.join(', ')}).`);
