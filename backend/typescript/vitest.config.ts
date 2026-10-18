import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 15_000,
    // 540 test files boot the whole app (`createApp`) in a `beforeAll`, and that
    // boot alone costs ~10s — exactly vitest's DEFAULT hookTimeout. None of them
    // override it, so every one was a scheduling hiccup away from a red
    // "Hook timed out in 10000ms" (which then cascades into a confusing
    // `afterAll` TypeError when the server ref was never assigned). Give hooks
    // the same headroom the tests get, so a timeout means genuinely stuck rather
    // than merely unlucky.
    hookTimeout: 30_000,
    // Per-worker isolated ~/.openwop-packs so parallel workers don't race
    // symlink churn in the shared dir (fixes the intermittent setup-timeout
    // flake). See test/setup/isolatePackDir.ts.
    // The clock-shift lane is OPT-IN (OPENWOP_CI_CLOCKSHIFT=1). See
    // test/setup/clockShift.ts — it advances the wall clock so a date bomb fires
    // in CI instead of on a random Tuesday, pointing at an innocent diff.
    // testServerKeepAlive.ts lifts every test server's keep-alive: a synchronous
    // stretch past Node's 5s default made the next pooled request ECONNRESET.
    // ADR 0863 D8 — a full suite outside a gate waits for a running gate's
    // claim first. Targeted runs never wait. See test/setup/queueBehindGate.ts.
    globalSetup: ['test/setup/queueBehindGate.ts'],
    // ADR 0880 — the Tracegate recorder rides along ONLY when a run asks for it
    // (OPENWOP_TRACEGATE_RECORD=<dir>). Unset, nothing is loaded and nothing changes.
    setupFiles: [
      // ADR 0880 — FIRST, so modules the other setup files load are mapped too.
      ...(process.env.OPENWOP_TRACEGATE_RECORD ? ['test/setup/tracegateRecorder.ts'] : []),
      'test/setup/isolatePackDir.ts',
      'test/setup/testServerKeepAlive.ts',
      ...(process.env.OPENWOP_CI_CLOCKSHIFT === '1' ? ['test/setup/clockShift.ts'] : []),
    ],
    // ADR 0880 — the recorder needs each file's verdict, which a setup file cannot
    // see. The JSON reporter rides beside the default one; unset, reporters are
    // exactly vitest's default.
    ...(process.env.OPENWOP_TRACEGATE_RECORD
      ? { reporters: ['default', ['json', { outputFile: `${process.env.OPENWOP_TRACEGATE_RECORD}/results.json` }]] }
      : {}),
  },
});
