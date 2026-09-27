/**
 * RFC 0133 witness boot — stands up the openwop-app reference host in-process so
 * the sibling `../openwop/conformance` RFC 0133 scenarios can run against a real
 * `/.well-known/openwop` advertising `workflowChainPacks.subChains`. Kept alive;
 * the caller runs the 5 sibling scenarios with OPENWOP_BASE_URL pointed here, then
 * kills this process. Mirrors the env setup of conformance/run.ts (memory storage,
 * fixed api key, test seam on); does NOT set OPENWOP_CHAIN_SUBCHAINS so sub-chains
 * advertise ON (the positive witness). Production NEVER runs this.
 */
import { createApp, loadConfigFromEnv } from '../src/index.js';

const PORT = Number(process.env.WITNESS_PORT ?? 18081);
const API_KEY = process.env.OPENWOP_API_KEY ?? 'sample-conformance-token';

async function main(): Promise<void> {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.PORT = String(PORT);
  process.env.OPENWOP_API_KEY = API_KEY;
  process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  // NB: OPENWOP_CHAIN_SUBCHAINS deliberately UNSET → subChains advertise supported:true.

  const app = await createApp({ ...loadConfigFromEnv(), port: PORT, storageDsn: 'memory://' });
  await new Promise<void>((res) => {
    const server = app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`[witness] openwop-app host listening at http://127.0.0.1:${PORT} (subChains advertised)`);
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
