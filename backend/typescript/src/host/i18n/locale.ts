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

/**
 * The case-canonical BCP 47 subset accepted as a content locale tag (RFC 0206
 * §A, `localized-content.md` §B): a lowercase 2–3 letter language, an optional
 * titlecase script, an optional uppercase or 3-digit region — `en`, `pt-BR`,
 * `fil`, `zh-Hant`, `zh-Hant-TW`, `es-419`.
 *
 * CORRECTED 2026-09-24 — this was RFC 0103's `^[a-z]{2}(-[A-Z]{2})?$`, while the
 * vendored `schemas/localized-content-*.schema.json` already carried the RFC 0206
 * pattern below: the host rejected with 400 a section the schema it ships
 * declares valid. Byte-identical to that schema pattern; a test pins the two.
 */
export const LOCALE_RE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

/** The primary language subtag (`pt-BR` → `pt`), lower-cased. */
function primarySubtag(tag: string): string {
  return tag.toLowerCase().split('-')[0] ?? tag.toLowerCase();
}

/** `ll-Ssss` (lower-cased) when `tag` carries a script subtag past it
 *  (`zh-Hant-TW` → `zh-hant`), else null. */
export function scriptPrefix(tag: string): string | null {
  const parts = tag.toLowerCase().split('-');
  return parts.length >= 3 && /^[a-z]{4}$/.test(parts[1] ?? '') ? `${parts[0]}-${parts[1]}` : null;
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
 * try an exact (case-insensitive) match in `supported`, then a script-family
 * match (RFC 0206), then a language-family match. Falls back to `defaultLocale` when nothing matches. Returns the
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
  const byScriptFamily = new Map<string, string>();
  for (const l of set) {
    const fam = primarySubtag(l);
    if (!byFamily.has(fam)) byFamily.set(fam, l); // first declared wins the family
    const sf = scriptPrefix(l);
    if (sf && !byScriptFamily.has(sf)) byScriptFamily.set(sf, l);
  }
  for (const { tag } of parseAcceptLanguage(acceptLanguage)) {
    const exact = exactByLower.get(tag.toLowerCase());
    if (exact) return exact;
    // Script family (RFC 0206, the same step `resolveSection` takes): a
    // `zh-Hant-TW` reader gets an advertised `zh-Hant` before any `zh-*`, so a
    // Traditional-Chinese reader is never handed a Simplified locale.
    const script = scriptPrefix(tag);
    const byScript = script ? (exactByLower.get(script) ?? byScriptFamily.get(script)) : undefined;
    if (byScript) return byScript;
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
  // A tag outside the grammar is DROPPED — it cannot be served, so it must not be
  // advertised — but never silently: an operator who configured it needs to know
  // discovery does not carry it (`OPENWOP_I18N_LOCALES=es-419` used to vanish
  // without a trace under the pre-RFC-0206 grammar).
  const all = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const tags = all.filter((s) => LOCALE_RE.test(s));
  const rejected = all.filter((s) => !LOCALE_RE.test(s));
  if (rejected.length > 0) warnRejectedLocales(rejected);
  const set = new Set<string>([hostDefaultLocale(), ...tags]);
  return [...set];
}

const warnedRejected = new Set<string>();
/** Once per distinct value per process — `hostSupportedLocales` runs per request. */
function warnRejectedLocales(rejected: readonly string[]): void {
  const key = rejected.join(',');
  if (warnedRejected.has(key)) return;
  warnedRejected.add(key);
  // eslint-disable-next-line no-console -- core-shared i18n infra has no logger dependency
  console.warn(
    `[i18n] OPENWOP_I18N_LOCALES: dropping ${rejected.map((t) => `"${t}"`).join(', ')} — not a case-canonical ` +
      'BCP 47 tag (RFC 0206: ll[l][-Ssss][-RR|-NNN]); these are NOT advertised in discovery.',
  );
}

/**
 * The advertised CONTENT locales (`capabilities.content.supportedLocales`, RFC
 * 0103 §A): the host locales minus the base, which section `data` carries. ONE
 * derivation for v1 discovery, the v2 `content` record, delivery negotiation and
 * `GET /content/settings` (ADR 0748), so none of them can disagree.
 */
export function hostContentLocales(): string[] {
  const base = hostDefaultLocale();
  return hostSupportedLocales().filter((l) => l !== base);
}

/** True when the operator has configured host content localization. */
export function hostI18nEnabled(): boolean {
  return hostSupportedLocales().length > 1;
}
