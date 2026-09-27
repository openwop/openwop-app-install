/**
 * RFC 0206 — the content-locale grammar and the script-family fallback.
 *
 * MEASURED 2026-09-24: `LOCALE_RE` was RFC 0103's `ll(-RR)` while the vendored
 * `schemas/localized-content-*.schema.json` already carried RFC 0206's pattern —
 * so the host 400'd a section overlay (`es-419`, `zh-Hant`) the schema it ships
 * declares valid, and `OPENWOP_I18N_LOCALES=es-419` vanished from discovery with
 * no trace. The parity leg below makes the next drift a red test, not a 400.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALE_RE, hostSupportedLocales, negotiateLocale } from '../src/host/i18n/locale.js';
import { resolveSection } from '../src/host/i18n/resolveSection.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('LOCALE_RE is the vendored schema pattern (RFC 0206 §A)', () => {
  it.each([
    'schemas/localized-content-section.schema.json',
    'schemas/v2/localized-content-section.schema.json',
  ])('byte-identical to the locale-key pattern in %s', (rel) => {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    const patterns = [...text.matchAll(/"pattern":\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(patterns, `${rel} must carry a locale pattern`).toContain(LOCALE_RE.source);
  });

  it.each(['en', 'pt-BR', 'fil', 'es-419', 'zh-Hant', 'zh-Hant-TW', 'sr-Latn-RS'])('accepts %s', (tag) => {
    expect(LOCALE_RE.test(tag)).toBe(true);
  });

  it.each(['EN', 'pt-br', 'zh-hant', 'zh-HANT', 'es-41', 'e', 'engl', 'en-US-x', 'en_US', ''])(
    'rejects the non-canonical %j',
    (tag) => {
      expect(LOCALE_RE.test(tag)).toBe(false);
    },
  );
});

describe('resolveSection — script-family step (localized-content.md §C, RFC 0206)', () => {
  const section = {
    data: { title: 'Hello', body: 'base' },
    localizations: { 'zh-Hant': { title: '你好 (Hant)' }, zh: { title: '你好 (zh)' }, es: { title: 'Hola' } },
  };

  it('zh-Hant-TW on { zh-Hant, zh } receives zh-Hant, not the language family', () => {
    expect(resolveSection(section, 'zh-Hant-TW', 'en')).toEqual({ title: '你好 (Hant)', body: 'base' });
  });

  it('an exact extended key wins over every fallback', () => {
    const s = { ...section, localizations: { ...section.localizations, 'es-419': { title: 'Hola (LatAm)' } } };
    expect(resolveSection(s, 'es-419', 'en')).toEqual({ title: 'Hola (LatAm)', body: 'base' });
  });

  it('a numeric region falls to the language family, never a script step', () => {
    expect(resolveSection(section, 'es-419', 'en')).toEqual({ title: 'Hola', body: 'base' });
  });

  it('pre-RFC-0206 sections resolve exactly as before (pt-BR → pt family)', () => {
    const s = { data: { t: 'x' }, localizations: { pt: { t: 'pt' } } };
    expect(resolveSection(s, 'pt-BR', 'en')).toEqual({ t: 'pt' });
  });
});

describe('OPENWOP_I18N_LOCALES — extended tags advertised, invalid ones dropped LOUDLY', () => {
  const saved = process.env.OPENWOP_I18N_LOCALES;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENWOP_I18N_LOCALES;
    else process.env.OPENWOP_I18N_LOCALES = saved;
    vi.restoreAllMocks();
  });

  it('keeps an RFC 0206 tag (es-419 used to vanish from discovery)', () => {
    process.env.OPENWOP_I18N_LOCALES = 'en,es-419,zh-Hant';
    expect(hostSupportedLocales()).toEqual(['en', 'es-419', 'zh-Hant']);
    expect(negotiateLocale('es-419', hostSupportedLocales(), 'en')).toBe('es-419');
  });

  it('drops a malformed tag from the advert AND warns naming it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.OPENWOP_I18N_LOCALES = 'en,es,EN_us-bogus-9';
    expect(hostSupportedLocales()).toEqual(['en', 'es']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"EN_us-bogus-9"');
  });
});
