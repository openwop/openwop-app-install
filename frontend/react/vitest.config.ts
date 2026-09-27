import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

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
  test: {
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
    setupFiles: process.env.OPENWOP_CI_CLOCKSHIFT === '1'
      ? ['src/test/i18n-setup.ts', 'src/test/shared-read-seams.ts', 'src/test/no-live-fetch.ts', 'src/test/clock-shift.ts']
      : ['src/test/i18n-setup.ts', 'src/test/shared-read-seams.ts', 'src/test/no-live-fetch.ts'],
  },
});
