import { describe, it, expect, beforeEach } from 'vitest';
import {
  formatNumber, formatCurrency, formatPercent, formatList,
  formatRelativeTime, formatBytes, getFormatLocale, setFormatLocale,
} from '../format.js';
import { resolveLocale, directionFor, SUPPORTED_LOCALES, DEFAULT_LOCALE } from '../locales.js';
import { pseudoLocalize } from '../pseudo.js';
import { resourcesByLocale, NAMESPACES } from '../resources.js';

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
  it('formats percent from a 0-1 ratio', () => {
    expect(formatPercent(0.42)).toBe('42%');
  });
  it('formats bytes + lists + relative time', () => {
    expect(formatBytes(2048)).toMatch(/2 kB/);
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
    expect(out.greeting).toContain('{{name}}');
    expect(out.greeting).not.toContain('Hello');
    expect(out.greeting).toMatch(/^⟦.*⟧$/);
  });
});

describe('catalogs', () => {
  it('aggregated en + pt-BR across all namespaces', () => {
    expect(NAMESPACES.length).toBeGreaterThan(40);
    expect(Object.keys(resourcesByLocale)).toEqual(expect.arrayContaining(['en', 'pt-BR']));
  });
  it('pt-BR has exact key parity with en in every namespace (no fallback leak)', () => {
    const en = resourcesByLocale.en;
    const pt = resourcesByLocale['pt-BR'];
    for (const ns of Object.keys(en)) {
      expect(Object.keys(pt[ns] ?? {}).sort(), `namespace '${ns}' parity`)
        .toEqual(Object.keys(en[ns]).sort());
    }
  });
  it('pt-BR actually translates the shared vocabulary (not copied)', () => {
    const ptCommon = resourcesByLocale['pt-BR'].common as Record<string, string>;
    expect(ptCommon.save).toBe('Salvar');
    expect(ptCommon.cancel).toBe('Cancelar');
  });
});
