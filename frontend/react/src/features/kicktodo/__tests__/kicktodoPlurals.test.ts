/**
 * KickTodo grade-i18n 2026-10-14 (KT-I18N-PLURAL-1): a `{{count}}` message whose
 * noun inflects must carry `_one`/`_other`, or English shows "1 seats left",
 * "1 days", "1 missed actions". i18next picks the suffix from CLDR plural rules
 * when `count` is passed, and only falls back to the bare key when no suffixed
 * form exists — so a bare key is the bug, silently.
 *
 * Two pins: (1) the resolved English for count 1 vs 3 on a real i18next
 * instance, and (2) a ratchet over every kicktodo* `en` catalog, so a new bare
 * `{{count}} <plural noun>` message fails here instead of reaching a reader.
 *
 * w52: the catalog list is now an `import.meta.glob` over every kicktodo package `i18n/en.ts`
 * (was hand-kept), floored at the measured 9. Sabotage-witnessed: a `_one` form
 * made plural (case 1), a new bare `{{count}} done tasks` (case 2).
 */
import { describe, it, expect } from 'vitest';
import i18next from 'i18next';
// Every kicktodo* package's `en` catalog, ENUMERATED (not hand-listed): a new
// `kicktodo-*` package is in the ratchet the moment it ships a catalog.
const modules = import.meta.glob<{ messages: Record<string, string> }>('../../kicktodo*/i18n/en.ts', { eager: true });
/** Vite keys a glob match RELATIVE to this file, and shortens this package's
 *  own catalog to `../i18n/en.ts` — so resolve the key before naming it. */
function nsOf(key: string): string {
  const abs = new URL(key, import.meta.url).pathname;
  const m = /\/(kicktodo[^/]*)\/i18n\/en\.ts$/.exec(abs);
  if (!m) throw new Error(`unexpected catalog path ${key}`);
  return m[1]!;
}
const catalogs: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(modules).map(([path, mod]) => [nsOf(path), mod.messages]),
);
/** Measured 2026-10-16 (w52): 9 kicktodo* packages carry an en catalog. A floor,
 *  so a glob that silently matches nothing cannot pass the scan below vacuously. */
const CATALOG_FLOOR = 9;

describe('KickTodo plural messages resolve per CLDR (KT-I18N-PLURAL-1)', () => {
  it('count 1 reads singular, count 3 plural, on a real i18next instance', async () => {
    const i = i18next.createInstance();
    await i.init({ lng: 'en', resources: { en: catalogs }, interpolation: { escapeValue: false } });
    expect(i.t('kicktodo-seats:seatsLeft', { count: 1 })).toBe('1 seat left');
    expect(i.t('kicktodo-seats:seatsLeft', { count: 3 })).toBe('3 seats left');
    expect(i.t('kicktodo:daysLabel', { count: 1 })).toBe('1 day');
    expect(i.t('kicktodo:daysLabel', { count: 30 })).toBe('30 days');
    expect(i.t('kicktodo:recoveryOfferTitle', { count: 1 })).toBe('1 missed action can become one');
    expect(i.t('kicktodo-studio:sourcesCount', { count: 1 })).toBe('1 source');
    expect(i.t('kicktodo-metrics:contributorCount', { count: 1 })).toBe('1 participant');
  });

  it('no bare `{{count}} <plural noun>` message remains in a kicktodo* en catalog', () => {
    expect(Object.keys(catalogs).length).toBeGreaterThanOrEqual(CATALOG_FLOOR);
    expect(Object.keys(catalogs)).toContain('kicktodo-seats');
    // A leading count followed by an English plural noun (or "N missed/remaining
    // <noun>s"). Labels such as `Intake: {{count}}`, `{{count}} min` and
    // `{{count}}-day target` do not inflect and are out of scope.
    const PLURAL_NOUN = /\{\{count\}\}\s+(?:\w+\s+)?[a-z]+s\b/;
    const bare: string[] = [];
    for (const [ns, cat] of Object.entries(catalogs)) {
      for (const [key, value] of Object.entries(cat)) {
        if (/_(zero|one|two|few|many|other)$/.test(key)) continue;
        if (PLURAL_NOUN.test(value)) bare.push(`${ns}:${key} = ${value}`);
      }
    }
    expect(bare).toEqual([]);
  });
});
