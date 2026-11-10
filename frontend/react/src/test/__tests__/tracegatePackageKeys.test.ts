/**
 * ADR 1028 P1 — i18n reads become the package's keyed reads of a catalog file.
 * Sabotage-witnessed (w89): dropping the `en-XA` → `en` mapping, dropping the namespace
 * filter on a key lookup, narrowing a whole read to one table or one language, swapping
 * lng/ns on the `i18n/locales/<lng>/<ns>.ts` layout, or accepting a non-locale file
 * (`index.ts`) as a table each turn a case red.
 */
import { describe, expect, it } from 'vitest';
import { packageKeys, tableOf } from '../tracegate-package-keys.js';

const FILES = [
  'frontend/react/src/features/csm/i18n/en.ts',
  'frontend/react/src/features/csm/i18n/es.ts',
  'frontend/react/src/features/forms/i18n/en.ts',
  'frontend/react/src/i18n/locales/en/common.ts',
  'frontend/react/src/site/i18n/en.ts',
  'frontend/react/src/features/csm/i18n/index.ts', // not a locale: ignored
];

function run(f: (k: ReturnType<typeof packageKeys>) => void): string[] {
  const out: string[] = [];
  f(packageKeys(FILES, (file, key) => out.push(`${file}#${key}`)));
  return out.sort();
}

describe('tracegate package keys (ADR 1028 P1)', () => {
  it('maps the three catalog layouts the store loads, and nothing else', () => {
    expect(tableOf('frontend/react/src/features/csm/i18n/en.ts')).toMatchObject({ lng: 'en', ns: 'csm' });
    expect(tableOf('frontend/react/src/i18n/locales/en/common.ts')).toMatchObject({ lng: 'en', ns: 'common' });
    expect(tableOf('frontend/react/src/site/i18n/en.ts')).toMatchObject({ lng: 'en', ns: 'site' });
    expect(tableOf('frontend/react/src/features/csm/i18n/index.ts')).toBeNull();
  });

  it('a lookup is a key of that language\'s table; the pseudo-locale reads en', () => {
    expect(run((k) => k.key('en', 'csm', 'title'))).toEqual(['frontend/react/src/features/csm/i18n/en.ts#title']);
    expect(run((k) => k.key('en-XA', 'csm', 'nested.label'))).toEqual(['frontend/react/src/features/csm/i18n/en.ts#nested.label']);
    expect(run((k) => k.key('es', 'forms', 'title'))).toEqual([]); // no such table: nothing to narrow
  });

  it('a whole read marks every table it can see as read whole', () => {
    expect(run((k) => k.whole('en', 'csm'))).toEqual(['frontend/react/src/features/csm/i18n/en.ts#*']);
    expect(run((k) => k.whole('en', '*'))).toEqual([
      'frontend/react/src/features/csm/i18n/en.ts#*',
      'frontend/react/src/features/forms/i18n/en.ts#*',
      'frontend/react/src/i18n/locales/en/common.ts#*',
      'frontend/react/src/site/i18n/en.ts#*',
    ]);
    expect(run((k) => k.whole('*', '*'))).toEqual([
      'frontend/react/src/features/csm/i18n/en.ts#*',
      'frontend/react/src/features/csm/i18n/es.ts#*',
      'frontend/react/src/features/forms/i18n/en.ts#*',
      'frontend/react/src/i18n/locales/en/common.ts#*',
      'frontend/react/src/site/i18n/en.ts#*',
    ]);
  });
});
