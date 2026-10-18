// ADR 0880 — Tracegate: KEY-level dependence on the frontend i18n tables.
//
// Every frontend test boots the full English catalog (src/test/i18n-setup.ts
// loads every namespace), and each table is ONE `export const messages = {…}`.
// Under the plain constant rule a single English-string edit therefore re-ran
// the whole lane: MEASURED, 988 of 1,003 footprints named
// `features/csm/i18n/en.ts::messages`.
//
// What a test can observe of a table, it observes through the i18next store:
// src/test/tracegate-i18n-recorder.ts records every key the test looks up
// (`<lng>\0<ns>\0<dotted.path>`), and every whole-table or whole-store read
// (`<lng>\0<ns>` / `<lng>\0*` / `*\0*`). A MODIFIED table then invalidates a
// test only when a key whose VALUE changed is one it looked up (or a table it
// read whole).
//
// Everything else falls back to the constant rule, never to "skip":
//   - a footprint without i18n reads (recorded before this, or not recorded);
//   - a test that loads a module importing the table, or the aggregator,
//     DIRECTLY (it can see the object without the store) — ingest lists these;
//   - a change outside the `messages` literal, or a literal this parser does not
//     fully understand (a spread, an identifier, a computed key, `${…}`);
//   - an added or deleted table.
// Plain JS, TypeScript passed in, so the self-test drives it without a lane.

/** The pseudo-locale is generated from `en` (src/i18n/pseudo.ts): a read of it is a read of `en`. */
export const DERIVED_FROM_EN = new Set(['en-XA']);
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** `{ lng, ns }` for a catalog path, mirroring `nsFromPath` in src/i18n/resources.ts; else null. */
export function tableOf(p) {
  let m = /^frontend\/react\/src\/features\/([^/]+)\/i18n\/([^/]+)\.ts$/.exec(p);
  if (m) return LOCALE.test(m[2]) ? { ns: m[1], lng: m[2] } : null;
  m = /^frontend\/react\/src\/i18n\/locales\/([^/]+)\/([^/]+)\.ts$/.exec(p);
  if (m) return LOCALE.test(m[1]) ? { lng: m[1], ns: m[2] } : null;
  m = /^frontend\/react\/src\/([^/]+)\/i18n\/([^/]+)\.ts$/.exec(p);
  if (m && m[1] !== 'features' && m[1] !== 'i18n') return LOCALE.test(m[2]) ? { ns: m[1], lng: m[2] } : null;
  return null;
}

/** Modules allowed to import catalogs without making a test a direct reader:
 *  they only feed the store (whose reads are recorded). */
export const AGGREGATORS = new Set([
  'frontend/react/src/i18n/resources.ts',
  'frontend/react/src/i18n/index.ts',
  'frontend/react/src/test/i18n-setup.ts',
]);
export const RESOURCES = 'frontend/react/src/i18n/resources.ts';

/** Relative module specifiers a source file imports, mocks or loads (resolved to repo paths, `.js` → `.ts`). */
export function importsOf(file, src) {
  const out = new Set();
  const dir = file.slice(0, file.lastIndexOf('/'));
  for (const m of src.matchAll(/(?:\bfrom|\bimport|\bmock|\bdoMock|\bimportActual|\bimportOriginal)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const parts = (dir + '/' + m[1]).split('/');
    const st = [];
    for (const x of parts) { if (x === '..') st.pop(); else if (x !== '.') st.push(x); }
    const p = st.join('/');
    out.add(p.replace(/\.js$/, '.ts'));
    if (!/\.[a-z]+$/.test(p)) { out.add(p + '.ts'); out.add(p + '/index.ts'); }
  }
  return [...out];
}

function unwrap(ts, n) {
  while (n && (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n))) n = n.expression;
  return n;
}

/** Map of dotted key → value text for `export const messages = {…}`; null when anything is not plain data. */
export function flatMessages(ts, src) {
  if (src === null || src === undefined) return null;
  const sf = ts.createSourceFile('t.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let obj = null;
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === 'messages') obj = unwrap(ts, d.initializer);
    }
  }
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  const out = new Map();
  const walk = (o, pre) => {
    for (const pr of o.properties) {
      if (!ts.isPropertyAssignment(pr)) return false; // spread, shorthand, method
      const nm = pr.name;
      if (!(ts.isIdentifier(nm) || ts.isStringLiteral(nm) || ts.isNumericLiteral(nm) || ts.isNoSubstitutionTemplateLiteral(nm))) return false;
      const key = pre + nm.text;
      const v = unwrap(ts, pr.initializer);
      if (ts.isObjectLiteralExpression(v)) { if (!walk(v, key + '.')) return false; continue; }
      if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) { out.set(key, 's:' + v.text); continue; }
      if (ts.isNumericLiteral(v) || v.kind === ts.SyntaxKind.TrueKeyword || v.kind === ts.SyntaxKind.FalseKeyword) { out.set(key, 'l:' + v.getText(sf)); continue; }
      if (ts.isArrayLiteralExpression(v) && v.elements.every((e) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) {
        out.set(key, 'a:' + JSON.stringify(v.elements.map((e) => e.text))); continue;
      }
      return false;
    }
    return true;
  };
  return walk(obj, '') ? out : null;
}

/** Keys whose value differs (added, removed or changed); null when either side is not plain data. */
export function changedMessageKeys(ts, before, after) {
  const a = flatMessages(ts, before), b = flatMessages(ts, after);
  if (!a || !b) return null;
  const out = [];
  for (const [k, v] of a) if (b.get(k) !== v) out.push(k);
  for (const k of b.keys()) if (!a.has(k)) out.push(k);
  return out;
}

const overlaps = (read, key) => read === key || key.startsWith(read + '.') || read.startsWith(key + '.');

/**
 * Does a recorded read set see a change to `changed` keys of table {lng, ns}?
 * Returns the first observed key (a string), or null when nothing it read changed.
 */
export function i18nHit(rec, { lng, ns }, changed) {
  if (!changed.length) return null; // a comment or formatting edit changes no value anyone can read
  const lngs = new Set([lng]);
  if (lng === 'en') for (const d of DERIVED_FROM_EN) lngs.add(d);
  for (const w of rec.whole ?? []) {
    const [wl, wn] = w.split('\0');
    if ((wl === '*' || lngs.has(wl)) && (wn === '*' || wn === ns)) return `the whole ${wn === '*' ? 'catalog' : `${ns} table`}`;
  }
  for (const r of rec.keys ?? []) {
    const [rl, rn, rp] = r.split('\0');
    if (rn !== ns || !lngs.has(rl)) continue;
    for (const k of changed) if (overlaps(rp, k)) return `${ns}:${k}`;
  }
  return null;
}
