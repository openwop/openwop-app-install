/**
 * Pseudo-localization (`en-XA`) — a QA locale, not a shipped language.
 *
 * Transforms the `en` catalog by accenting letters and padding length ~40% to
 * surface (1) un-externalized strings — anything still rendered in plain ASCII
 * was never wrapped in `t()` — and (2) text-expansion breakage. Interpolation
 * tokens (`{{name}}`) are preserved verbatim. NOT in `SUPPORTED_LOCALES`; gated
 * by {@link PSEUDO_LOCALE_ENABLED}.
 */

export const PSEUDO_LOCALE = 'en-XA';

export const PSEUDO_LOCALE_ENABLED: boolean =
  (typeof import.meta !== 'undefined' && import.meta.env?.DEV === true) ||
  (typeof location !== 'undefined' && new URLSearchParams(location.search).has('pseudo'));

const ACCENTS: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ',
  k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: 'ɋ', r: 'ŕ', s: 'š', t: 'ţ',
  u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ҳ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ',
  K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Ɋ', R: 'Ŕ', S: 'Š', T: 'Ţ',
  U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ҳ', Y: 'Ý', Z: 'Ž',
};

function pseudoString(value: string): string {
  let out = '';
  let inToken = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '{' && value[i + 1] === '{') inToken = true;
    if (inToken) {
      out += ch;
      if (ch === '}' && value[i - 1] === '}') inToken = false;
      continue;
    }
    out += ACCENTS[ch] ?? ch;
  }
  const padCount = out.length >= 4 ? Math.ceil(out.length * 0.4) : 0;
  const pad = padCount > 0 ? ` ${'·'.repeat(padCount)}` : '';
  return `⟦${out}${pad}⟧`;
}

/** Recursively pseudo-localize a catalog (namespaces → keys → strings). */
export function pseudoLocalize(resources: unknown): unknown {
  if (typeof resources === 'string') return pseudoString(resources);
  if (Array.isArray(resources)) return resources.map(pseudoLocalize);
  if (resources && typeof resources === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(resources)) out[k] = pseudoLocalize(v);
    return out;
  }
  return resources;
}
