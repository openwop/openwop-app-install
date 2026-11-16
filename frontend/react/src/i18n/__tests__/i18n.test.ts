/**
 * The i18n runtime layer: the `format.ts` Intl wrappers (locale grouping, currency,
 * MINOR-unit currency by the currency's own decimals — money), locale negotiation
 * (`locales.ts`: base-language fallback, RTL by base language), pseudo-localization's
 * interpolation-token guard, and the ADR 0329 / ADR 0490 catalog split (only `en`
 * eager; lazy pt-BR has exact key parity with en and real translations).
 *
 * Sabotage (wave 51 probes): a bare `/100`-style fixed decimal count, dropping the
 * base-language match, RTL on the full tag, an unguarded `{{token}}`, or a pt-BR key
 * removed/untranslated each red a case. NOT witnessed by design: `resolveLocale`'s
 * exact-tag branch — every supported locale has a unique base language, so the base
 * match returns the same answer (probe w51g1-i18n-exact-branch; a redundant product
 * branch, not a test gap).
 *
 * Re-graded (grade-tests w116): bytes and the pseudo string are exact literals
 * (a padding change or a '12 kB' now reds), and the ADR 0065 i18next init must
 * keep `showSupportNotice: false` (dropping it reds the last case).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  formatNumber, formatCurrency, formatCurrencyMinor, formatPercent, formatList,
  formatRelativeTime, formatBytes, getFormatLocale, setFormatLocale,
} from '../format.js';
import { resolveLocale, directionFor, SUPPORTED_LOCALES, DEFAULT_LOCALE } from '../locales.js';
import { pseudoLocalize } from '../pseudo.js';
import { resourcesByLocale, NAMESPACES, loadLocaleResources, lazyLocaleNamespaces, loadLocaleNamespace } from '../resources.js';

/**
 * A locale's FULL resources = its shell chunk + its deferred feature namespaces.
 * The locale follow-up to ADR 0490 split the latter out, so a test that wants
 * cross-locale key parity has to reassemble both halves — comparing a full `en`
 * against a shell-only locale would report every deferred namespace as missing,
 * which is a fact about chunking, not about translation coverage.
 */
async function fullLocale(locale: string): Promise<Record<string, Record<string, unknown>> | null> {
  const shell = await loadLocaleResources(locale);
  if (!shell) return null;
  const out: Record<string, Record<string, unknown>> = { ...shell };
  await Promise.all(
    lazyLocaleNamespaces(locale).map(async (ns) => {
      const messages = await loadLocaleNamespace(locale, ns);
      if (messages) out[ns] = messages;
    }),
  );
  return out;
}

describe('Intl formatting layer', () => {
  beforeEach(() => setFormatLocale('en-US'));

  it('tracks the active locale', () => {
    setFormatLocale('de-DE');
    expect(getFormatLocale()).toBe('de-DE');
  });
  it('groups numbers per locale', () => {
    setFormatLocale('en-US'); expect(formatNumber(1234567)).toBe('1,234,567');
    setFormatLocale('de-DE'); expect(formatNumber(1234567)).toBe('1.234.567');
  });
  it('localizes currency while keeping the amount', () => {
    setFormatLocale('en-US'); expect(formatCurrency(1234.5, 'USD')).toBe('$1,234.50');
  });
  it('formats MINOR-unit amounts with the currency’s own decimals (not a bare /100)', () => {
    setFormatLocale('en-US');
    expect(formatCurrencyMinor(123456, 'USD')).toBe('$1,234.56'); // 2 dp
    expect(formatCurrencyMinor(123456, 'JPY')).toBe('¥123,456');  // 0 dp — /100 would be 100x wrong
    // 3-dp currency (BHD): 123456 minor = 123.456
    expect(formatCurrencyMinor(123456, 'BHD')).toBe('BHD\u00a0123.456');
  });
  it('formats percent from a 0-1 ratio', () => {
    expect(formatPercent(0.42)).toBe('42%');
  });
  it('formats bytes + lists + relative time', () => {
    expect(formatBytes(2048)).toBe('2 kB'); // exact: a regex /2 kB/ also passed '12 kB'
    expect(formatList(['A', 'B', 'C'])).toBe('A, B, and C');
    const now = new Date('2026-06-18T12:00:00Z');
    expect(formatRelativeTime(new Date('2026-06-18T11:58:00Z'), now)).toBe('2 minutes ago');
  });
});

describe('locale negotiation', () => {
  it('declares supported locales with en as source-of-truth + default', () => {
    expect(SUPPORTED_LOCALES).toContain('en');
    expect(DEFAULT_LOCALE).toBe('en');
  });
  it('resolves exact + base-language, falling back to default', () => {
    expect(resolveLocale('en-US')).toBe('en');
    // fr/es are supported (promoted 2026-06-20) → base-language match, not fallback.
    expect(resolveLocale('fr-CA')).toBe('fr');
    expect(resolveLocale('es-MX')).toBe('es');
    // A genuinely unsupported language still falls back to the default.
    expect(resolveLocale('de-DE')).toBe('en');
    expect(resolveLocale(null)).toBe('en');
  });
  it('reports RTL direction', () => {
    expect(directionFor('en')).toBe('ltr');
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('he-IL')).toBe('rtl');
  });
});

describe('pseudo-localization', () => {
  it('accents + preserves interpolation tokens', () => {
    const out = pseudoLocalize({ greeting: 'Hello {{name}}' }) as { greeting: string };
    // Computed by hand: 'Hello' accented letter by letter, the token verbatim,
    // then ceil(14 × 0.4) = 6 padding dots for the 14-character body.
    expect(out.greeting).toBe('⟦Ĥéļļó {{name}} ······⟧');
  });
});

describe('catalogs', () => {
  // ADR 0329 — only `en` is eager; every other locale (pt-BR included) loads
  // through the lazy per-locale path, so these tests exercise that loader.
  it('aggregates en eagerly across all namespaces; pt-BR is lazy-only', () => {
    // 132 namespaces MEASURED 2026-10-16 (e3c2492be) — the floor is the truth, not 40.
    // 128 after KickTodo's four namespaces left (ADR 1031 P3).
    // CAUTION (grade-tests w116, TST-OAF-1): this counts more than the EAGER set.
    // `NAMESPACES` is the array passed to i18next as `ns`, and i18next pushes every
    // namespace that `src/test/i18n-setup.ts` preloads into that same array, so in
    // this suite it holds eager + lazy (inferred: the tree has 35 eager catalogs at
    // 63e4c73654, so 128 is reachable no other way). The eager/lazy split itself is
    // pinned by namespaceSplit.test.ts, not here.
    expect(NAMESPACES.length).toBeGreaterThanOrEqual(128);
    expect(Object.keys(resourcesByLocale)).toEqual(['en']);
  });
  it('lazy pt-BR has exact key parity with en in every namespace (no fallback leak)', async () => {
    const en = resourcesByLocale.en;
    if (!en) throw new Error('the eager en catalog is missing');
    const pt = await fullLocale('pt-BR');
    expect(pt).not.toBeNull();
    for (const [ns, messages] of Object.entries(en)) {
      expect(Object.keys(pt![ns] ?? {}).sort(), `namespace '${ns}' parity`)
        .toEqual(Object.keys(messages).sort());
    }
  });
  it('lazy pt-BR actually translates the shared vocabulary (not copied)', async () => {
    const pt = await fullLocale('pt-BR');
    const ptCommon = pt!.common as Record<string, string>;
    expect(ptCommon.save).toBe('Salvar');
    expect(ptCommon.cancel).toBe('Cancelar');
  });
});

describe('i18next init', () => {
  // i18next >= 25 logs a Locize sponsorship notice on init unless this is false;
  // a white-label public site must not print a third party's ad in its console.
  it('suppresses the vendor support notice', async () => {
    const { default: i18n } = await import('../index.js');
    expect(i18n.options.showSupportNotice).toBe(false);
  });
});
