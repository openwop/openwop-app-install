/**
 * GATE-6 — the WIRING between `scripts/e2e-routes.sh` and `playwright.config.ts`.
 *
 * `scripts/test-gate-tooling.sh` proves the MECHANISM (port picking, ownership
 * walking) in isolation. That is not the same as proving the two halves are
 * connected correctly, and the difference is not academic here: GATE-1 was a
 * correct-in-isolation guard wired to the wrong process tree, and it reached main
 * because this stage runs only under `ci:full`. ADR 0502's lesson, paid for
 * again — test mechanism and wiring SEPARATELY.
 *
 * What makes these assertions worth having is that they run in the DEFAULT gate
 * while the stage they describe does not. They are deliberately about the
 * resolved CONFIG, which needs no server, no browser and no backend: the
 * expensive half (does exactly one Vite actually run?) lives in
 * `scripts/test-e2e-routes-wiring.sh`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const CONFIG = '../../playwright.config.ts';

/** Re-resolve the config under a controlled environment. The config reads
 *  `process.env` at MODULE SCOPE, so the module registry must be reset or every
 *  case would see whichever env the first import happened to observe. */
async function resolveConfig(env: Record<string, string | undefined>): Promise<{
  use: { baseURL: string; storageState: { origins: { origin: string }[] } };
  webServer: { command: string; url: string; reuseExistingServer: boolean; env?: Record<string, string> };
}> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    vi.resetModules();
    const mod = await import(CONFIG);
    return mod.default;
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

afterEach(() => { vi.resetModules(); });

describe('GATE-6 — reuse is what makes it ONE Vite, not two', () => {
  it('ADOPTS the running server when the lane says the server is ours', async () => {
    // `e2e-routes.sh` boots its own Vite and then sets this, having PROVEN every
    // listener on the port descends from the server it started. Without reuse,
    // Playwright starts a SECOND Vite — the double-server bug this closes.
    const cfg = await resolveConfig({ OPENWOP_E2E_REUSE_SERVER: '1', OPENWOP_E2E_PORT: undefined });
    expect(cfg.webServer.reuseExistingServer).toBe(true);
  });

  it('REFUSES to adopt by default — an unproven server is never someone else\'s to bind', async () => {
    // The hard-won default (see the config's own comment): with reuse on
    // unconditionally, a suite in any worktree silently binds whatever holds the
    // port, and a green run may never have executed your code.
    for (const v of [undefined, '0', 'true', 'yes']) {
      const cfg = await resolveConfig({ OPENWOP_E2E_REUSE_SERVER: v, OPENWOP_E2E_PORT: undefined });
      expect(cfg.webServer.reuseExistingServer, `OPENWOP_E2E_REUSE_SERVER=${String(v)} must not enable reuse`).toBe(false);
    }
  });
});

describe('GATE-6 — every port-bearing field agrees, or the suite tests the wrong server', () => {
  it('points baseURL, webServer.url and the spawn command at the SAME port', async () => {
    const cfg = await resolveConfig({ OPENWOP_E2E_PORT: '5199', OPENWOP_E2E_REUSE_SERVER: '1' });
    expect(cfg.use.baseURL).toBe('http://localhost:5199');
    expect(cfg.webServer.url).toBe('http://localhost:5199');
    // If the command's --port drifted from the URL, Playwright would wait on one
    // port while its server bound another: two servers, and a timeout that reads
    // like a slow machine rather than a wiring bug.
    expect(cfg.webServer.command).toContain('--port 5199');
    // --strictPort is load-bearing: without it Vite silently hops to the next
    // free port when the chosen one is taken, and the suite then drives a server
    // on an address nothing else agreed on.
    expect(cfg.webServer.command).toContain('--strictPort');
  });

  it('anchors the entered-app marker to that same origin', async () => {
    // storageState seeds `openwop:app-entered` per ORIGIN. On a mismatched port
    // the marker lands on an origin the tests never visit, so '/' renders the
    // marketing page and app specs fail for a reason that looks unrelated.
    const cfg = await resolveConfig({ OPENWOP_E2E_PORT: '5199', OPENWOP_E2E_REUSE_SERVER: '1' });
    expect(cfg.use.storageState.origins.map((o) => o.origin)).toEqual(['http://localhost:5199']);
  });

  it('falls back to 5173 when the lane names no port', async () => {
    const cfg = await resolveConfig({ OPENWOP_E2E_PORT: undefined, OPENWOP_E2E_REUSE_SERVER: undefined });
    expect(cfg.use.baseURL).toBe('http://localhost:5173');
  });
});

describe('GATE-6 — the backend-address coupling that caused the split-backend outage', () => {
  it('does NOT re-declare the API base itself, so it cannot disagree with the lane', async () => {
    // #2784: `ci.sh` moved the backend to an auto-selected port but told only the
    // Vite PROXY, while the app's own fallback still called :8080 — the page and
    // the fixtures talked to DIFFERENT BACKENDS and 11 specs failed.
    //
    // `webServer.env` MERGES over process.env rather than replacing it, which is
    // why the lane works: `ci.sh` exports VITE_OPENWOP_BASE_URL and the spawned
    // Vite inherits it. That also means pinning a value HERE would silently
    // override the lane's choice and rebuild the same split. So the contract is
    // that this block carries the auth posture and nothing address-shaped.
    const cfg = await resolveConfig({ OPENWOP_E2E_PORT: '5199', OPENWOP_E2E_REUSE_SERVER: '1' });
    expect(cfg.webServer.env).toEqual({ VITE_OPENWOP_AUTH_MODE: 'cookie' });
    for (const key of Object.keys(cfg.webServer.env ?? {})) {
      expect(key, 'webServer.env must not pin a backend address — the lane owns that')
        .not.toMatch(/BASE_URL|PROXY_TARGET|PORT/);
    }
  });
});
