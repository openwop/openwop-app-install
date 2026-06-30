import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 15_000,
    // Per-worker isolated ~/.openwop-packs so parallel workers don't race
    // symlink churn in the shared dir (fixes the intermittent setup-timeout
    // flake). See test/setup/isolatePackDir.ts.
    setupFiles: ['test/setup/isolatePackDir.ts'],
  },
});
