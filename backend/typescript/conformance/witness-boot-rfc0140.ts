/**
 * RFC 0140 witness boot — stands up the openwop-app reference host in-process so
 * the sibling `../openwop/conformance` scenario
 * `replay-side-effect-suppression.test.ts` can run against a real
 * `/.well-known/openwop` advertising `replay.sideEffectSuppression:
 * "recorded-outcome"` AND a real `GET /v1/host/sample/replay/effect-count`.
 *
 * Kept alive; the caller points OPENWOP_BASE_URL here, runs the scenario, then
 * kills this process. Mirrors the env setup of conformance/run.ts (memory
 * storage, fixed api key, test seam ON — the seam's env gate) and the
 * witness-boot-rfc0133.ts precedent. Production NEVER runs this.
 *
 * `OPENWOP_ENABLE_CONFORMANCE_NODES` is left at its default (ON outside
 * NODE_ENV=production) so the conformance-only nodes are registered — without
 * them the fixtures fail to execute and the scenario reds for the wrong reason.
 *
 * CORRECTION 2026-08-17 (H48): this line used to say the switch mattered for
 * `conformance.effect.emit` specifically, "without it both fixtures fail to
 * execute". Both halves were imprecise. The scenario
 * `replay-side-effect-suppression.test.ts` drives ONLY
 * `conformance-replay-side-effect` (`WORKFLOW_ID`, corpus `origin/main`), whose
 * node is `core.conformance.side-effect` — NOT `conformance.effect.emit`, and
 * not the two host-authored `conformance-replay-effect*` fixtures, which the
 * corpus never names and no scenario drives. The switch IS still required here,
 * for `core.conformance.side-effect`; the reason was attached to the wrong node.
 *
 * Named for RFC 0140 because that is what it was written for; it has since
 * become the general "point the sibling suite at a real openwop-app" boot (the
 * ADR 0552 P2 and ADR 0556 P3 witnesses at main were taken through it), which
 * is why the surface switches below are not RFC-0140-specific.
 */
import { createApp, loadConfigFromEnv } from '../src/index.js';

const PORT = Number(process.env.WITNESS_PORT ?? 18082);
const API_KEY = process.env.OPENWOP_API_KEY ?? 'sample-conformance-token';

async function main(): Promise<void> {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.PORT = String(PORT);
  process.env.OPENWOP_API_KEY = API_KEY;
  process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  // ── Surfaces a sibling-suite drive needs from THIS boot (H19/H25) ──────────
  //
  // This boot is what an operator points `OPENWOP_BASE_URL` at when driving the
  // sibling `../openwop/conformance` suite by hand — which is how the ADR 0552
  // P2 and ADR 0556 P3 witnesses at main were taken. Only HOST-side switches
  // belong here: `OPENWOP_A2A_FAKE_PEER` is read by the SUITE's `setup.ts`, in
  // the suite's own process, so it is set on the vitest invocation and not here
  // (setting it here would look like configuration and do nothing).
  //
  // - A2A server + durable tasks: without them the a2a legs gate off entirely.
  // - WEBHOOK_ALLOW_PRIVATE: the RFC 0093 egress guard refuses a loopback peer
  //   (`127.0.0.1`) before the first socket, so the host cannot reach the
  //   suite's fake peer without it. This was the first-run refusal observed
  //   while taking the 0552 P2 witness.
  // - PACKS_TEST_NAMESPACE_ENABLED: mounts the RFC 0025 §C test-mode mirror and
  //   flips `capabilities.packs.testMode.supported`, so the `pack-registry-*`
  //   legs EXECUTE instead of recording `inapplicable`.
  process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
  process.env.OPENWOP_A2A_DURABLE_TASKS = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED = 'true';

  const app = await createApp({ ...loadConfigFromEnv(), port: PORT, storageDsn: 'memory://' });
  await new Promise<void>((res) => {
    const server = app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`[witness] openwop-app host listening at http://127.0.0.1:${PORT} (RFC 0140)`);
      res();
      void server;
    });
  });
  // Stay alive until killed.
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[witness] boot error:', err);
  process.exit(1);
});
