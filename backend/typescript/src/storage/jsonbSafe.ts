/**
 * Postgres `jsonb` / `text` safety for serialized values (ADR 0975 D10,
 * CC-SEARCH-1, CC-SEARCH-1b). A LEAF module so both the storage adapter and the
 * host surfaces that write jsonb themselves (pgvector chunk metadata) share ONE
 * sanitiser instead of each remembering to.
 *
 * - U+0000 cannot be stored in `jsonb` or `text` (`unsupported Unicode escape
 *   sequence`); MEASURED on kicktodo.com 2026-10-27.
 * - An UNPAIRED UTF-16 surrogate (half an emoji, left by a code-unit `slice` of
 *   fetched text) serializes as a lone `\udXXX` escape, which `jsonb` rejects
 *   with `invalid input syntax for type json`; MEASURED on app.openwop.dev
 *   2026-11-12 (CC-SEARCH-1).
 * Both become U+FFFD: lossless for every other character, and visible. Valid
 * surrogate pairs are untouched. Object KEYS are not rewritten (a replacer only
 * sees values); no write path here takes untrusted keys.
 */

const LONE_SURROGATE_SRC = '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]';
const LONE_SURROGATE = new RegExp(LONE_SURROGATE_SRC);
const LONE_SURROGATE_G = new RegExp(LONE_SURROGATE_SRC, 'g');

/** `JSON.stringify` replacer: NUL and unpaired surrogates become U+FFFD. */
export function nulSafe(_key: string, v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const noNul = v.includes('\u0000') ? v.replaceAll('\u0000', '�') : v;
  return LONE_SURROGATE.test(noNul) ? noNul.replace(LONE_SURROGATE_G, '�') : noNul;
}

/** One string made jsonb/text-safe (for values a replacer never sees, e.g. object
 *  KEYS built from text, and `text` parameters, where NUL fails the write too). */
export function jsonbSafeString(s: string): string {
  return nulSafe('', s) as string;
}

/** `JSON.stringify(value, nulSafe)` — the text every jsonb parameter carries. */
export function jsonbStringify(value: unknown): string {
  return JSON.stringify(value, nulSafe);
}
