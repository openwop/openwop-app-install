#!/usr/bin/env node
/**
 * i18n integrity gate (ADR 0065) — replaces compile-time key typing.
 *
 * Catalogs live in three places (namespace derived from path):
 *   core   →  src/i18n/locales/<locale>/<ns>.ts
 *   feature→  src/features/<id>/i18n/<locale>.ts          (ns = <id>)
 *   area   →  src/<area>/i18n/<locale>.ts                 (ns = <area>)
 * Each exports `export const messages = { key: 'value', … } as const;`
 * (one `key: 'value',` per line, 2-space indent).
 *
 * Checks:
 *  1. KEY PARITY (fatal) — every `t('ns:key')` / `t('key')` resolves to a
 *     defined catalog key.
 *  2. ORPHANS (warn) — defined keys never referenced (literal-token-aware).
 *  3. FORMATTING BAN (fatal; `OPENWOP_I18N_FORMAT=lenient` downgrades) — raw
 *     `toFixed`/`toLocale*String`/`$`-concat outside `src/i18n/format.ts`.
 *  4. CROSS-LOCALE PARITY (fatal) — every non-`en` catalog matches its `en`
 *     namespace exactly (no key leaks English via fallback).
 *  5. MOJIBAKE (fatal) — a catalog VALUE that is correct text mis-decoded as
 *     Latin-1 and re-encoded. Checks 1–4 are all about keys and pass garbage
 *     values; two shipped. See the block above the check for the decode test.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
/** `OPENWOP_GATE_SRC` points the REAL script at a fixture tree — the same seam
 *  `check-notice-announce` / `check-failure-card-announce` use, so this gate's
 *  own tests exercise the shipped scanner rather than a copy of it. Unset in
 *  every normal invocation. */
const SRC = process.env.OPENWOP_GATE_SRC ? resolve(process.env.OPENWOP_GATE_SRC) : join(ROOT, 'src');
const STRICT_FORMAT = process.env.OPENWOP_I18N_FORMAT !== 'lenient';
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const FORMAT_RE = /\.toFixed\(|\.toLocaleString\(|\.toLocale(Date|Time)String\(|\$\$\{|'\$'\s*\+|"\$"\s*\+/;

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      walk(full, exts, out);
    } else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

/** Discover catalog files for a locale: Map<namespace, filepath>. */
function discoverCatalogs(locale) {
  const cat = new Map();
  // core: src/i18n/locales/<locale>/*.ts
  const coreDir = join(SRC, 'i18n', 'locales', locale);
  if (existsSync(coreDir)) {
    for (const f of readdirSync(coreDir)) {
      if (f.endsWith('.ts')) cat.set(f.replace(/\.ts$/, ''), join(coreDir, f));
    }
  }
  // feature: src/features/<id>/i18n/<locale>.ts  +  area: src/<area>/i18n/<locale>.ts.
  // walk() matches basenames, so collect all .ts then match the full path.
  const featRe = new RegExp(`^features/([^/]+)/i18n/${locale}\\.ts$`);
  const areaRe = new RegExp(`^([^/]+)/i18n/${locale}\\.ts$`);
  for (const file of walk(SRC, ['.ts'])) {
    const rel = relative(SRC, file).replace(/\\/g, '/');
    let m = rel.match(featRe);
    if (m) { cat.set(m[1], file); continue; }
    m = rel.match(areaRe);
    if (m && m[1] !== 'i18n') cat.set(m[1], file);
  }
  return cat;
}

/**
 * Strip comments. The reference-mining pass below already does this, for exactly
 * this reason — "so example calls in doc-comments aren't treated as call sites".
 * IT WAS APPLIED TO ONE SIDE OF THE COMPARISON ONLY.
 *
 * The cost of the asymmetry: a key that exists ONLY INSIDE A COMMENT satisfied
 * the "is it defined?" check, so `check-i18n` reported "all t() references
 * resolve" for a string that can never render. Three of them shipped through
 * tsc, eslint and this gate in one batch (2026-07-29) and were caught only by
 * mounting the component, where `t('hbLoadFailedTitle')` came back as the raw key.
 *
 * A catalog docstring reaches 2-space indentation easily — ADR 0065's own
 * example line is `` * use ... with `{{count}}`. `` — so this is not exotic.
 *
 * ── ADR 0602 (appended, not a rewrite): THE STRIPPER ITSELF WAS THE HOLE ──────
 *
 * The body was a two-`replace` regex pair, and a regex has no idea what a string
 * literal is. A `/` immediately followed by `*` inside an ordinary attribute
 * value therefore OPENS a block comment that runs to the next comment-close
 * ANYWHERE in the file. MEASURED on `features/notebooks/NotebooksPage.tsx`
 * (coordinates as of the commit where the defect existed, `d6bd6c261`: L448, a
 * span of 106 lines — NOT the post-PR `:577`/"~115 lines" this note first cited,
 * which is `L3` in the ADR 0602 correction log): the file-input `accept`
 * attribute listing the `audio/` and `video/` wildcard MIME types opened one, and
 * the `{ }`-wrapped JSX comment above the Notes panel closed it — so that entire
 * span was deleted before mining. Every `t()` call inside it was invisible to the
 * FATAL key-parity check below. Via `rawKeys` below, the same flaw could also
 * make a catalog under-report its DEFINED keys.
 *
 * ── ADR 0602 § Correction log, item B (`H1`/`H2`): THE FIRST CURE WAS ALSO ────
 * ── THE HOLE, IN BOTH DIRECTIONS ──────────────────────────────────────────────
 *
 * The first fix replaced the regex pair with a hand-rolled character scanner
 * that tracked string literals. It was still not a lexer, and hand-rolling a TS
 * lexer is the class of thing not to hand-roll. Two defects, each PROVED by
 * fixture:
 *
 *   H1 — FATAL FALSE POSITIVE on innocent code. A JSX apostrophe (`Here's the
 *        source list`) is ordinary text to a parser and an OPENING QUOTE to a
 *        character scanner. From there the scanner is desynchronised: the `/**`
 *        of the next doc comment is "inside a string", so the comment is NOT
 *        stripped and an EXAMPLE `t('…')` in it is mined as a live call site —
 *        EXIT=1 naming a key that was never referenced. RE-MEASURED here against
 *        the real corpus, using the parser as ground truth: **118 comment lines
 *        survived the hand-rolled stripper across 7 files** (worst:
 *        `src/chat/tabDeck/TabStrip.tsx`), with **34 desync triggers across 25
 *        files** (JSX text or a regex literal carrying a quote or `//`). The
 *        review reported 191/8 and 49/7 under a different counting rule; the
 *        numbers above are the ones this repo can reproduce, and the conclusion
 *        is the same under either. None of the survivors happened to contain a
 *        `t(` — green by luck, not by construction. The OLD regex did not have
 *        this failure mode, so the "fix" traded a latent hole for a live one.
 *
 *   H2 — the class it was written to close, still open. In
 *        `/^[a-z]+:\/\//.test(url) ? t('a') : t('b')` the regex literal's
 *        trailing `\/\/` reads as a LINE COMMENT, the rest of the line is
 *        deleted, and BOTH keys vanish from the fatal check. Verbatim the
 *        failure this docblock is about.
 *
 * The cure is to stop writing a lexer: `typescript` is already a dependency, so
 * the REAL parser locates comments (in TSX, where JSX text, regex literals and
 * template substitutions are all understood) and this function only blanks the
 * ranges it reports. Comment bodies are replaced SPACE-FOR-SPACE with newlines
 * kept, so byte offsets and line numbers survive stripping — the previous
 * versions collapsed a block comment to one space and silently moved every
 * position after it.
 *
 * The ORPHAN half is deliberately unaffected: `literalTokens` reads the
 * UNSTRIPPED source by design, which is why the orphan count does not move.
 *
 * @see scripts/__tests__/gates.test.ts — three regression fixtures, one per
 *   class (apostrophe-in-JSX, quote-in-char-class, regex-containing-`//`).
 */
const stripComments = (src, fileName = 'file.tsx') => {
  const sf = ts.createSourceFile(
    fileName, src, ts.ScriptTarget.Latest, /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  // Every comment is leading trivia of exactly one token, so walking to the
  // leaves (including EndOfFileToken, which carries a trailing comment at EOF)
  // enumerates all of them. Keyed by start position because a node and its first
  // child share a full-start and would otherwise report the same comment twice.
  const ranges = new Map();
  const visit = (node) => {
    ts.forEachLeadingCommentRange(src, node.getFullStart(), (pos, end) => { ranges.set(pos, end); });
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  if (ranges.size === 0) return src;
  let out = '';
  let cursor = 0;
  for (const [pos, end] of [...ranges.entries()].sort((a, b) => a[0] - b[0])) {
    if (pos < cursor) continue;
    out += src.slice(cursor, pos);
    out += src.slice(pos, end).replace(/[^\n]/g, ' ');
    cursor = end;
  }
  return out + src.slice(cursor);
};

/** Exact key names defined in one catalog file (suffixes kept). */
function rawKeys(path) {
  const keys = new Set();
  for (const m of stripComments(readFileSync(path, 'utf8'), path).matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9_]*)\s*:/gm)) keys.add(m[1]);
  return keys;
}

// --- defined keys (en), base form (plural suffix stripped) -------------------
const enCatalogs = discoverCatalogs('en');
const defined = new Map(); // ns -> Set(baseKey)
for (const [ns, path] of enCatalogs) {
  const base = new Set();
  for (const k of rawKeys(path)) base.add(k.replace(PLURAL_SUFFIX, ''));
  defined.set(ns, base);
}

// --- references + formatting scan --------------------------------------------
const referenced = new Map();
const literalTokens = new Set();
// Constructed-key prefixes — `t(\`status_${x}\`)` marks every `status_*` key
// as potentially used. Without this, enum-keyed families (status_/channel_/
// tab_/…) report as orphans forever (136 false positives at introduction).
const constructedPrefixes = new Set();
const missing = [];
const formatViolations = [];
const hardcoded = [];
const CATALOG_PATHS = new Set([...enCatalogs.values()]);

// Un-externalized user-facing copy in JSX (warn — heuristic, false-positive-prone,
// so non-fatal like ORPHANS; flip strict via an allowlist once it's clean, the way
// FORMAT_RE was). Catches the gap PARITY/REFERENCE checks can't: literal JSX text and
// human-readable `title`/`aria-label`/`placeholder` attrs that never reached a catalog.
// A line already carrying `t(`, `i18nKey`, or `<Trans` is assumed handled and skipped.
const JSX_TEXT_RE = /<\/?[A-Za-z][^>]*>[A-Z][a-z]+ [A-Za-z][A-Za-z ,.!?'"-]{6,}</;
const ATTR_TEXT_RE = /\b(?:placeholder|aria-label|title|alt)=["'][A-Z][a-z]+ [A-Za-z]/;

for (const file of walk(SRC, ['.ts', '.tsx'])) {
  const rel = relative(ROOT, file);
  // Skip catalog files + locale catalogs from reference mining (INFRA-7: the
  // former comment-only `if` above this check is gone — this is the one gate).
  const isCatalog = CATALOG_PATHS.has(file) || /\/i18n\/locales\//.test(rel) || /\/i18n\/(en|pt-BR|[a-z]{2}(-[A-Z]{2})?)\.ts$/.test(rel);
  if (isCatalog || rel.endsWith('.d.ts')) continue;
  const src = readFileSync(file, 'utf8');
  // Strip comments before mining t() refs so example calls in doc-comments
  // (e.g. the framework's own `t('common:x')` doc) aren't treated as call sites.
  // Parser-backed — see `stripComments` for why neither a regex nor a
  // hand-rolled character scanner could do this job.
  const code = stripComments(src, file);

  const nsMatch = code.match(/useTranslation\(\s*\[?\s*['"]([a-zA-Z0-9_-]+)['"]/);
  const fileNs = nsMatch ? nsMatch[1] : 'common';

  // `tt(` is the chassis's TYPE-namespace translator (ADR 0340 — PropertyField
  // resolves constructed `prop_${name}`/`opt_${name}_${value}` keys through it).
  for (const m of code.matchAll(/(?:\bt\(|\btt\()\s*`([a-zA-Z][a-zA-Z0-9_.:-]*)\$\{/g)) {
    const p = m[1].split(':').pop();
    if (p && p.length >= 3) constructedPrefixes.add(p);
  }
  for (const m of code.matchAll(/(?:\bt\(|i18nKey=)\s*['"]([a-zA-Z0-9_:.-]+)['"]/g)) {
    const raw = m[1];
    const [ns, key] = raw.includes(':') ? raw.split(':') : [fileNs, raw];
    const base = key.split('.')[0].replace(PLURAL_SUFFIX, '');
    if (!referenced.has(ns)) referenced.set(ns, new Set());
    referenced.get(ns).add(base);
    const set = defined.get(ns);
    if (!set || !set.has(base)) missing.push(`${rel}: t('${raw}') → no '${base}' key in namespace '${ns}'`);
  }
  for (const m of src.matchAll(/['"](?:[a-zA-Z0-9_]+:)?([a-zA-Z][a-zA-Z0-9_]*)['"]/g)) {
    literalTokens.add(m[1].replace(PLURAL_SUFFIX, ''));
  }
  if (!rel.includes('i18n/format.ts') && !rel.includes('i18n/pseudo.ts')) {
    src.split('\n').forEach((line, i) => { if (FORMAT_RE.test(line)) formatViolations.push(`${rel}:${i + 1}: ${line.trim()}`); });
  }
  if (file.endsWith('.tsx') && !/(^|\/)test\//.test(rel) && !/\.(test|spec)\.tsx$/.test(rel)) {
    src.split('\n').forEach((line, i) => {
      if (/\bt\(|i18nKey|<Trans/.test(line)) return; // already routed through a catalog
      if (JSX_TEXT_RE.test(line) || ATTR_TEXT_RE.test(line)) hardcoded.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
}

// --- orphans -----------------------------------------------------------------
const orphans = [];
for (const [ns, keys] of defined) {
  const used = referenced.get(ns) ?? new Set();
  for (const k of keys) {
    if (used.has(k) || literalTokens.has(k)) continue;
    let constructed = false;
    for (const p of constructedPrefixes) { if (k.startsWith(p)) { constructed = true; break; } }
    if (!constructed) orphans.push(`${ns}:${k}`);
  }
}

// --- cross-locale parity -----------------------------------------------------
const parityProblems = [];
const localeDirs = new Set();
const coreLocales = join(SRC, 'i18n', 'locales');
if (existsSync(coreLocales)) for (const d of readdirSync(coreLocales)) if (d !== 'en') localeDirs.add(d);
for (const f of walk(SRC, ['.ts'])) {
  const m = relative(SRC, f).replace(/\\/g, '/').match(/\/i18n\/([a-z]{2}(?:-[A-Z]{2})?)\.ts$/);
  if (m && m[1] !== 'en') localeDirs.add(m[1]);
}
for (const loc of localeDirs) {
  const locCat = discoverCatalogs(loc);
  for (const [ns, enPath] of enCatalogs) {
    const enKeys = rawKeys(enPath);
    const locPath = locCat.get(ns);
    if (!locPath) { parityProblems.push(`${loc}: namespace '${ns}' missing entirely`); continue; }
    const locKeys = rawKeys(locPath);
    for (const k of enKeys) if (!locKeys.has(k)) parityProblems.push(`${loc}/${ns}: missing key '${k}'`);
    for (const k of locKeys) if (!enKeys.has(k)) parityProblems.push(`${loc}/${ns}: extra key '${k}' (not in en)`);
  }
}

// --- mojibake ----------------------------------------------------------------
/**
 * Check 5 (fatal) — MOJIBAKE IN CATALOG VALUES.
 *
 * WHY THIS EXISTS. Every check above is about KEYS: parity finds a key that is
 * missing or extra, and passes a value that is garbage. Two user-visible strings
 * shipped corrupt in two locales and no gate in the build noticed:
 * `profile-memory/en.ts` carried a UTF-8 em dash decoded as Latin-1 and
 * re-encoded (U+00E2 U+0080 U+0094, which renders as a stray letter plus two
 * invisible C1 controls), and `profile-memory/es.ts` carried `est` + U+00C3
 * U+00A1 where `est` + U+00E1 belongs. Both files are valid UTF-8 — that is the
 * point. Nothing about the ENCODING is wrong; the TEXT is the Latin-1 misreading
 * of correct text, so no encoding validator can see it.
 *
 * HOW, and why it is not a character-class heuristic. Naively flagging "accented
 * letter followed by punctuation" false-positives on real prose (French
 * `e-acute` before a closing guillemet, Spanish inverted marks). Instead this is
 * a DECODE test, which is exact: take each maximal run of Latin-1-range
 * characters (U+0080..U+00FF), re-encode it as those bytes, and try to decode
 * those bytes as strict UTF-8. Correct text fails that decode — a lone U+00E9 is
 * byte E9, which announces two continuation bytes that are not there. Mojibake
 * SUCCEEDS, because it is by construction a valid UTF-8 byte sequence that was
 * shown one byte at a time. A run is reported only when the decode succeeds AND
 * yields something different, which is precisely the definition of the defect.
 *
 * Runs are extracted rather than whole lines because a line may also contain
 * characters above U+00FF (curly quotes), which have no Latin-1 byte at all.
 */
// Written as escapes, not literals: half this range is invisible C1 controls.
const LATIN1_RUN = /[\u0080-\u00ff]{2,}/g;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const mojibake = [];
const catalogFiles = new Set(enCatalogs.values());
for (const loc of localeDirs) for (const p of discoverCatalogs(loc).values()) catalogFiles.add(p);
for (const file of catalogFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(LATIN1_RUN)) {
      const run = m[0];
      const bytes = Uint8Array.from([...run].map((c) => c.codePointAt(0)));
      let decoded;
      try { decoded = strictUtf8.decode(bytes); } catch { continue; } // not valid UTF-8 ⇒ real text
      if (decoded === run) continue;
      const show = (s) => [...s].map((c) => (c.codePointAt(0) > 126 ? `<U+${c.codePointAt(0).toString(16)}>` : c)).join('');
      mojibake.push(`${rel}:${i + 1}: ${show(run)} should be ${show(decoded)}`);
    }
  });
}

// --- report ------------------------------------------------------------------
let failed = false;
if (missing.length) {
  failed = true;
  console.error(`\n✗ check-i18n: ${missing.length} unresolved t() key reference(s):`);
  for (const m of missing.slice(0, 80)) console.error(`  ${m}`);
}
if (parityProblems.length) {
  failed = true;
  console.error(`\n✗ check-i18n: ${parityProblems.length} cross-locale parity problem(s):`);
  for (const p of parityProblems.slice(0, 80)) console.error(`  ${p}`);
}
if (mojibake.length) {
  failed = true;
  console.error(`\n✗ check-i18n: ${mojibake.length} mojibake sequence(s) in catalog values (text mis-decoded as Latin-1):`);
  for (const m of mojibake.slice(0, 80)) console.error(`  ${m}`);
}
if (orphans.length) {
  console.warn(`\n⚠ check-i18n: ${orphans.length} orphaned catalog key(s) (not referenced):`);
  for (const o of orphans.slice(0, 40)) console.warn(`  ${o}`);
}
if (hardcoded.length) {
  console.warn(`\n⚠ check-i18n: ${hardcoded.length} likely un-externalized user-facing string(s) in JSX (wrap in t()/<Trans>):`);
  for (const h of hardcoded.slice(0, 40)) console.warn(`  ${h}`);
}
if (formatViolations.length) {
  const lvl = STRICT_FORMAT ? 'error' : 'warn';
  console[lvl](`\n${STRICT_FORMAT ? '✗' : '⚠ (OPENWOP_I18N_FORMAT=lenient)'} check-i18n: ${formatViolations.length} raw formatting site(s) outside src/i18n/format.ts:`);
  for (const v of formatViolations.slice(0, 60)) console[lvl](`  ${v}`);
  if (STRICT_FORMAT) failed = true;
}
if (failed) { console.error('\ncheck-i18n FAILED.'); process.exit(1); }
const total = [...defined.values()].reduce((n, s) => n + s.size, 0);
const warnTail = [
  orphans.length ? `${orphans.length} orphans` : null,
  hardcoded.length ? `${hardcoded.length} hardcoded` : null,
].filter(Boolean).join(', ');
console.log(`✓ check-i18n: ${total} keys across ${defined.size} namespaces; all t() references resolve.${warnTail ? ` (${warnTail} — non-fatal)` : ''}`);
