/**
 * ADR 1028 P1 — the i18n reads `tracegate-i18n-recorder.ts` sees, reported to the
 * tracegate-ci PACKAGE as keyed reads of a catalog file (`recordKeyRead(file, key)`).
 *
 * The fork records `<lng>\0<ns>\0<path>`; the package wants the repo path of the table
 * and the key inside it. Whole reads become `*` on every table they can see, so a test
 * that read a bundle or the whole store is never narrowed to the keys it also looked up.
 * The pseudo-locale is generated from `en` (src/i18n/pseudo.ts), so its reads are `en`'s.
 * Pure: the catalog list and the sink are passed in, so a test drives it without a
 * recorder.
 */

export interface Table { file: string; lng: string; ns: string }

const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const DERIVED: Record<string, string> = { 'en-XA': 'en' };

/** `{ lng, ns }` for a catalog path, mirroring `tableOf` in scripts/lib/tracegate-i18n.mjs. */
export function tableOf(file: string): Table | null {
  let m = /^frontend\/react\/src\/features\/([^/]+)\/i18n\/([^/]+)\.ts$/.exec(file);
  if (m) return LOCALE.test(m[2]!) ? { file, ns: m[1]!, lng: m[2]! } : null;
  m = /^frontend\/react\/src\/i18n\/locales\/([^/]+)\/([^/]+)\.ts$/.exec(file);
  if (m) return LOCALE.test(m[1]!) ? { file, lng: m[1]!, ns: m[2]! } : null;
  m = /^frontend\/react\/src\/([^/]+)\/i18n\/([^/]+)\.ts$/.exec(file);
  if (m && m[1] !== 'features' && m[1] !== 'i18n') return LOCALE.test(m[2]!) ? { file, ns: m[1]!, lng: m[2]! } : null;
  return null;
}

export type Sink = (file: string, key: string) => void;

export function packageKeys(files: readonly string[], sink: Sink) {
  const tables = files.map(tableOf).filter((t): t is Table => t !== null);
  const base = (lng: string): string => DERIVED[lng] ?? lng;
  return {
    /** One lookup: `key` of namespace `ns` in language `lng`. */
    key(lng: string, ns: string, key: string): void {
      const l = base(lng);
      for (const t of tables) if (t.lng === l && t.ns === ns) sink(t.file, key);
    },
    /** A read that can see a whole table, a whole language (`ns` = `*`) or everything (`*`, `*`). */
    whole(lng: string, ns: string): void {
      const l = lng === '*' ? '*' : base(lng);
      for (const t of tables) if ((l === '*' || t.lng === l) && (ns === '*' || t.ns === ns)) sink(t.file, '*');
    },
  };
}
