/**
 * Locale negotiation (RFC 0103 / `i18n.md` annex) — core-shared i18n infra
 * (depends on nothing under `features/`).
 *
 * `negotiateLocale` parses an `Accept-Language` header the way the annex
 * requires: it NEVER throws/400 on a malformed header, honors q-values, and
 * falls back exact-tag → language-family → host default. The host's advertised
 * locale set is operator-config (env), so a host that hasn't configured
 * localization advertises nothing (capability honesty).
 *
 * @see ../../../docs/adr/0064-cms-content-localization.md
 * @see ../../../../openwop/spec/v1/i18n.md
 */

/** BCP-47 subset accepted as a content locale tag (`en`, `pt-BR`). */
export const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

/** The primary language subtag (`pt-BR` → `pt`), lower-cased. */
function primarySubtag(tag: string): string {
  return tag.toLowerCase().split('-')[0] ?? tag.toLowerCase();
}

interface RankedTag {
  tag: string;
  q: number;
  order: number;
}

/** Parse `Accept-Language` into q-ranked tags. Never throws; a malformed segment
 *  is skipped, an absent/empty header yields []. */
function parseAcceptLanguage(header: string | undefined | null): RankedTag[] {
  if (!header || typeof header !== 'string') return [];
  const out: RankedTag[] = [];
  let order = 0;
  for (const part of header.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const [rawTag, ...params] = seg.split(';');
    const tag = (rawTag ?? '').trim();
    if (!tag) continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) {
        const parsed = Number.parseFloat(m[1]!);
        if (Number.isFinite(parsed)) q = Math.min(Math.max(parsed, 0), 1);
      }
    }
    if (q > 0) out.push({ tag, q, order: order++ });
  }
  // Highest q first; ties broken by request order (earlier wins).
  return out.sort((a, b) => (b.q !== a.q ? b.q - a.q : a.order - b.order));
}

/**
 * Pick the locale to serve. Walks the client's q-ranked preferences: for each,
 * try an exact (case-insensitive) match in `supported`, then a language-family
 * match. Falls back to `defaultLocale` when nothing matches. Returns the
 * canonical tag FROM `supported` (so `Content-Language` is the host's casing).
 */
export function negotiateLocale(
  acceptLanguage: string | undefined | null,
  supported: readonly string[],
  defaultLocale: string,
): string {
  const set = supported.length > 0 ? supported : [defaultLocale];
  const exactByLower = new Map(set.map((l) => [l.toLowerCase(), l]));
  const byFamily = new Map<string, string>();
  for (const l of set) {
    const fam = primarySubtag(l);
    if (!byFamily.has(fam)) byFamily.set(fam, l); // first declared wins the family
  }
  for (const { tag } of parseAcceptLanguage(acceptLanguage)) {
    const exact = exactByLower.get(tag.toLowerCase());
    if (exact) return exact;
    const fam = byFamily.get(primarySubtag(tag));
    if (fam) return fam;
  }
  return defaultLocale;
}

// ── Host-level capability config (operator-controlled, honesty-gated) ────────

/** The host content default locale (`OPENWOP_I18N_DEFAULT_LOCALE`, default `en`). */
export function hostDefaultLocale(): string {
  const v = (process.env.OPENWOP_I18N_DEFAULT_LOCALE ?? 'en').trim();
  return LOCALE_RE.test(v) ? v : 'en';
}

/**
 * The host's advertised content locales (`OPENWOP_I18N_LOCALES`, comma-separated
 * BCP-47 tags). EMPTY by default — a host that hasn't configured localization
 * advertises no `capabilities.i18n` (advertise only what is honored). The host
 * default is always included; duplicates and the default are de-duped.
 */
export function hostSupportedLocales(): string[] {
  const raw = (process.env.OPENWOP_I18N_LOCALES ?? '').trim();
  if (!raw) return [];
  const tags = raw.split(',').map((s) => s.trim()).filter((s) => LOCALE_RE.test(s));
  const set = new Set<string>([hostDefaultLocale(), ...tags]);
  return [...set];
}

/** True when the operator has configured host content localization. */
export function hostI18nEnabled(): boolean {
  return hostSupportedLocales().length > 1;
}
