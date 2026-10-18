import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ADR 0880 P0 — vitest's on-disk transform cache. MEASURED on 38 files: summed
// transform 460 s → 149 s warm, wall −10%; the gate runs this lane twice (unit,
// then the date-bomb sweep), so the second run is warm inside one gate. Vitest
// does not put plugin OPTIONS in its cache key, so the directory is keyed on this
// file (it holds the stub plugin) and the lockfile (plugin versions): any change
// to either lands in a fresh cache. OPENWOP_VITEST_FS_CACHE=0 turns it off.
const fsCacheKey = createHash('sha256')
  .update(readFileSync(new URL('./vitest.config.ts', import.meta.url)))
  .update(readFileSync(new URL('./package-lock.json', import.meta.url)))
  .digest('hex')
  .slice(0, 16);

// Test runner config (GAP-ANALYSIS F1). Mirrors the two vite.config.ts pieces
// the test graph needs: the React plugin (JSX/TSX transform) and the
// webhook-helpers stub (the @openwop/openwop barrel re-exports node:crypto
// HMAC helpers that would otherwise fail to resolve under the test bundler).
// Vite resolves the codebase's `.js` import specifiers to their `.ts(x)`
// sources automatically, so tests import exactly as app code does.
const stubWebhookHelpers: Plugin = {
  name: 'openwop-stub-webhook-helpers',
  enforce: 'pre',
  load(id: string) {
    if (/[/\\]@openwop[/\\]openwop[/\\]dist[/\\]webhook-helpers\.js$/.test(id)) {
      return 'export {};';
    }
    return null;
  },
};

export default defineConfig({
  plugins: [react(), stubWebhookHelpers],
  // ADR 0880 P0 — tests import backend sources (`../../backend/typescript/src/…`),
  // which sit outside this root. Vite admits such a file only after it sees the
  // import while transforming the importer; with fsModuleCache warm that
  // transform comes from the cache, so an EDITED backend file (cache miss) was
  // refused and the test failed as "Cannot find module '/@fs/…'". Allowing the
  // repo root makes the access check independent of what the cache skipped.
  server: { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
  test: {
    experimental: {
      fsModuleCache: process.env.OPENWOP_VITEST_FS_CACHE !== '0',
      fsModuleCachePath: `node_modules/.vitest-fs-cache/${fsCacheKey}`,
    },
    environment: 'jsdom',
    globals: true,
    // `scripts/**/__tests__` is included so the BUILD GATES can have tests. They are part of
    // the build contract — a gate that silently stops enforcing is worse than no
    // gate — and until now nothing covered them.
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/__tests__/*.{test,spec}.ts'],
    // Bootstrap i18n (ADR 0065) so component tests render real English copy
    // instead of raw translation keys — see src/test/i18n-setup.ts.
    // The clock-shift lane is OPT-IN (OPENWOP_CI_CLOCKSHIFT=1) and mirrors the
    // backend's. See src/test/clock-shift.ts — the sweep was backend-only, so a
    // date bomb in this workspace could not be found by the gate written to
    // find date bombs.
    setupFiles: [
      // ADR 0880 — FIRST, so modules the other setup files load are mapped too.
      ...(process.env.OPENWOP_TRACEGATE_RECORD ? ['src/test/tracegate-recorder.ts'] : []),
      'src/test/i18n-setup.ts',
      'src/test/shared-read-seams.ts',
      'src/test/no-live-fetch.ts',
      // ADR 0880 — after i18n-setup, so only the test's own i18n lookups are recorded.
      ...(process.env.OPENWOP_TRACEGATE_RECORD ? ['src/test/tracegate-i18n-recorder.ts'] : []),
      ...(process.env.OPENWOP_CI_CLOCKSHIFT === '1' ? ['src/test/clock-shift.ts'] : []),
    ],
    // ADR 0880 — the recorder needs each file's verdict; unset, reporters are vitest's default.
    ...(process.env.OPENWOP_TRACEGATE_RECORD
      ? { reporters: ['default', ['json', { outputFile: `${process.env.OPENWOP_TRACEGATE_RECORD}/results.json` }]] }
      : {}),
  },
});
