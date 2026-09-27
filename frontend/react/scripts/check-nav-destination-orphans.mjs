#!/usr/bin/env node
/**
 * "Route withdrawn, nav strings RETAINED" — the class gate (ADR 0603 §6 / `PODC-13`).
 *
 * THE CLASS, and why it needed its own instrument. When a top-level destination is
 * withdrawn, its `<x>Label` / `<x>Hint` pair in `i18n/locales/<locale>/nav.ts` is left
 * behind — four locales' worth of copy describing a place nobody can go. It has now
 * been HALF-FIXED TWICE: `4dc9091a9` deleted `notebooksLabel`/`notebooksHint` and left
 * `podcastsLabel`/`podcastsHint` two lines away, both orphaned by ONE sentence in
 * `features/registry.ts` withdrawing BOTH routes.
 *
 * `check-i18n` already prints these BY NAME and still exits 0, because orphans there
 * are `console.warn` and never set `failed`. That is a defensible position on a
 * 248-item global warning list — and it is exactly why the class survived two
 * sweeps: a warning that names your defect and passes is indistinguishable from a
 * warning that doesn't. This gate takes the NARROW, fully-cleared subset and makes it
 * FATAL at zero.
 *
 * SCOPE, deliberately narrow. Only `nav.ts`, and only keys that form a Label+Hint
 * PAIR — the shape a nav DESTINATION entry takes. A lone `<x>Label` may be a chip, a
 * column header, an aria-label; a pair is a place. Narrow enough to hold at zero,
 * which is the only ratchet position that cannot be gamed.
 *
 * WHAT IT DOES NOT CLAIM.
 * 1. Reference detection is a quoted-token scan over `src` (minus the catalogs
 *    themselves). A key assembled at runtime — `` t(`${id}Label`) `` — would be
 *    invisible. MEASURED at the time of writing: no such construction exists for nav
 *    keys anywhere in `src`, which is what makes the scan sound HERE; it would not be
 *    sound as a general i18n orphan detector, and this is not one.
 * 2. It says nothing about the OTHER locales. `en/nav.ts` is the key SSoT and
 *    `check-i18n`'s cross-locale parity check is what keeps the other three in step —
 *    so a key deleted here must be deleted everywhere or that gate goes red. The two
 *    gates cover the two halves; neither duplicates the other.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { stripComments } from './failureCardScan.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.OPENWOP_GATE_SRC ?? join(__dirname, '..', 'src');
const NAV = join(SRC, 'i18n', 'locales', 'en', 'nav.ts');

const nav = readFileSync(NAV, 'utf8');
const keys = [...nav.matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
const pairs = keys
  .filter((k) => k.endsWith('Label'))
  .map((l) => ({ label: l, hint: `${l.slice(0, -'Label'.length)}Hint` }))
  .filter((p) => keys.includes(p.hint));

// VACUITY GUARD. This gate's whole output is "0 orphans"; if the key parse silently
// stopped matching, that zero would read as success. Derived from the file, not a
// magic number: `nav.ts` is the app's main-navigation catalog and holds dozens of
// destinations — a handful means the regex, not the catalog, changed.
if (keys.length < 100 || pairs.length < 40) {
  console.error(`✗ check-nav-destination-orphans: parsed ${keys.length} keys / ${pairs.length} Label+Hint pairs from ${relative(SRC, NAV)} — the PARSE is broken, not the catalog clean.`);
  process.exit(1);
}

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(ts|tsx)$/.test(p)) continue;
    if (p.includes(join('i18n', 'locales'))) continue; // the catalogs are not references
    files.push(p);
  }
})(SRC);
// `L2` (ADR 0603 R1) — COMMENTS ARE NOT REFERENCES. This scan is a quoted-token
// search, so a nav key merely MENTIONED in a comment — `// was 'podcastsLabel'`,
// or a docblock explaining why a destination was withdrawn — reads as a live
// reference and keeps the orphan alive. That direction is a silent false NEGATIVE,
// and it is the likeliest one here: the comment that explains a withdrawal is
// exactly the comment that names the key. The sibling `failureCardScan.mjs` already
// exports `stripComments` for this reason, and this repo has a standing lesson that
// ratchet gates count comments — so the fix is to REUSE it, not to write a second
// one. Not live today (0 hits either way); closed before it bites.
const corpus = files.map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');
const used = (k) => corpus.includes(`'${k}'`) || corpus.includes(`"${k}"`) || corpus.includes(`\`${k}\``);

// SECOND VACUITY GUARD — a corpus that failed to load would make EVERY pair look
// orphaned (loud, so harmless) but a corpus that accidentally included the catalogs
// would make every pair look USED (silent, and the failure mode that matters).
const control = pairs.filter((p) => used(p.label)).length;
if (control === 0) {
  console.error('✗ check-nav-destination-orphans: NO nav label is referenced anywhere — the corpus scan is broken.');
  process.exit(1);
}

const orphans = pairs.filter((p) => !used(p.label) && !used(p.hint));
if (orphans.length > 0) {
  console.error(`✗ check-nav-destination-orphans: ${orphans.length} nav destination(s) have copy in all four locales and no route:`);
  for (const o of orphans) console.error(`    ${o.label} + ${o.hint}`);
  console.error('  A withdrawn destination must take its nav strings with it — in EVERY locale.');
  console.error('  Delete the pair from src/i18n/locales/{en,es,fr,pt-BR}/nav.ts.');
  process.exit(1);
}

console.log(`✓ check-nav-destination-orphans: 0 orphaned nav destinations of ${pairs.length} Label+Hint pairs (${control} referenced).`);
