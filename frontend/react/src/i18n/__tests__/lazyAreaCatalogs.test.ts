/**
 * Shared-chunk headroom (2026-10-26) — the `workforces` and `settings` AREA catalogs
 * left the eager `en` bundle and now load through the ADR 0490 namespace backend.
 *
 * The suite's setup preloads every lazy namespace (src/test/i18n-setup.ts), so a copy
 * assertion in a page test cannot show the lazy path works. This file drops the
 * preloaded bundle and proves through `t()` that the real backend delivers the copy.
 * (The eager exclusion itself is pinned by namespaceSplit.test.ts and measured by the
 * bundle budget; the runtime namespace lists cannot show it, because i18next adds
 * every loaded namespace to them.)
 *
 * Sabotage: dropping either glob from the lazy loader list in resources.ts reds the
 * matching case (the backend then resolves empty and the raw key comes back).
 */
import { describe, it, expect } from 'vitest';
import i18n from '../index.js';
import { LAZY_EN_NAMESPACES } from '../resources.js';

const CASES = [
  { ns: 'workforces', key: 'galleryTitle', copy: 'Your AI workforces' },
  { ns: 'settings', key: 'hbRetry', copy: 'Try again' },
] as const;

describe('lazy route-only area catalogs', () => {
  for (const { ns, key, copy } of CASES) {
    it(`\`${ns}\` is deferred and its copy arrives through the namespace backend`, async () => {
      expect(LAZY_EN_NAMESPACES).toContain(ns);

      i18n.removeResourceBundle('en', ns);
      expect(i18n.t(`${ns}:${key}`, { lng: 'en' })).toBe(key);

      await i18n.reloadResources('en', [ns]);
      expect(i18n.t(`${ns}:${key}`, { lng: 'en' })).toBe(copy);
    });
  }
});
