/**
 * Core i18n helper (ADR 0064) — negotiateLocale + resolveSection unit tests +
 * the core-purity boundary guard (host/i18n MUST NOT import features/).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { negotiateLocale } from '../src/host/i18n/locale.js';
import { resolveSection } from '../src/host/i18n/resolveSection.js';

describe('negotiateLocale (RFC 0103 / i18n.md)', () => {
  const supported = ['en', 'es', 'pt-BR', 'fr'];

  it('picks the exact highest-q supported tag', () => {
    expect(negotiateLocale('fr;q=0.5, es;q=0.9', supported, 'en')).toBe('es');
  });

  it('falls back to the language family (ja-JP → no, pt-PT → pt-BR family)', () => {
    expect(negotiateLocale('pt-PT', supported, 'en')).toBe('pt-BR'); // pt family
  });

  it('falls back to the default when nothing matches', () => {
    expect(negotiateLocale('de, ja;q=0.8', supported, 'en')).toBe('en');
  });

  it('NEVER throws on a malformed header — returns the default', () => {
    expect(() => negotiateLocale('!!!;;;q=abc', supported, 'en')).not.toThrow();
    expect(negotiateLocale('!!!;;;q=abc', supported, 'en')).toBe('en');
    expect(negotiateLocale(undefined, supported, 'en')).toBe('en');
    expect(negotiateLocale('', supported, 'en')).toBe('en');
  });

  it('honors q=0 as "not acceptable" and respects request order on ties', () => {
    expect(negotiateLocale('es;q=0, fr', supported, 'en')).toBe('fr');
    expect(negotiateLocale('fr, es', supported, 'en')).toBe('fr'); // tie → first wins
  });

  it('is case-insensitive on the request tag', () => {
    expect(negotiateLocale('PT-br', supported, 'en')).toBe('pt-BR');
  });
});

describe('resolveSection (RFC 0103 §C — byte-identical merge)', () => {
  const base = { heading: 'Welcome', cta: 'Get started' };

  it('returns base data for the base locale or when nothing is authored', () => {
    expect(resolveSection({ data: base }, 'en', 'en')).toEqual(base);
    expect(resolveSection({ data: base, localizations: {} }, 'es', 'en')).toEqual(base);
  });

  it('overlays an exact-locale override (shallow field replace)', () => {
    const s = { data: base, localizations: { es: { heading: 'Bienvenido' } } };
    expect(resolveSection(s, 'es', 'en')).toEqual({ heading: 'Bienvenido', cta: 'Get started' });
  });

  it('overlays a language-family override when no exact match', () => {
    const s = { data: base, localizations: { pt: { heading: 'Bem-vindo' } } };
    expect(resolveSection(s, 'pt-BR', 'en')).toEqual({ heading: 'Bem-vindo', cta: 'Get started' });
  });

  it('prefers the exact locale over the family', () => {
    const s = { data: base, localizations: { pt: { heading: 'pt' }, 'pt-BR': { heading: 'pt-BR' } } };
    expect(resolveSection(s, 'pt-BR', 'en')).toEqual({ heading: 'pt-BR', cta: 'Get started' });
  });

  it('falls through to base when the negotiated locale has no override', () => {
    const s = { data: base, localizations: { es: { heading: 'Bienvenido' } } };
    expect(resolveSection(s, 'fr', 'en')).toEqual(base);
  });

  it('never mutates the input', () => {
    const loc = { es: { heading: 'Bienvenido' } };
    const s = { data: { ...base }, localizations: loc };
    resolveSection(s, 'es', 'en');
    expect(s.data).toEqual(base);
    expect(loc.es).toEqual({ heading: 'Bienvenido' });
  });
});

describe('core-purity boundary (ADR 0001)', () => {
  it('host/i18n imports nothing from features/', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host', 'i18n');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      // Ignore the doc-comment @see paths; only fail on real import statements.
      const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+['"]/.test(l));
      for (const line of importLines) {
        expect(line, `${f}: ${line.trim()}`).not.toMatch(/features\//);
      }
    }
  });
});
