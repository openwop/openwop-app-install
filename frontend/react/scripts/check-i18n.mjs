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
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
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

/** Exact key names defined in one catalog file (suffixes kept). */
function rawKeys(path) {
  const keys = new Set();
  for (const m of readFileSync(path, 'utf8').matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9_]*)\s*:/gm)) keys.add(m[1]);
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
  if (/\/i18n\/(locales\/|[a-zA-Z-]+\.ts$)/.test(rel) || rel.endsWith('.d.ts') || CATALOG_PATHS.has(file)) {
    // skip catalog files + locale catalogs from reference mining
  }
  const isCatalog = CATALOG_PATHS.has(file) || /\/i18n\/locales\//.test(rel) || /\/i18n\/(en|pt-BR|[a-z]{2}(-[A-Z]{2})?)\.ts$/.test(rel);
  if (isCatalog || rel.endsWith('.d.ts')) continue;
  const src = readFileSync(file, 'utf8');
  // Strip comments before mining t() refs so example calls in doc-comments
  // (e.g. the framework's own `t('common:x')` doc) aren't treated as call sites.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const nsMatch = code.match(/useTranslation\(\s*\[?\s*['"]([a-zA-Z0-9_-]+)['"]/);
  const fileNs = nsMatch ? nsMatch[1] : 'common';

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
  for (const k of keys) if (!used.has(k) && !literalTokens.has(k)) orphans.push(`${ns}:${k}`);
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
