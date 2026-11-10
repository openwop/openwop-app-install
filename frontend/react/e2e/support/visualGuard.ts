import type { Browser } from '@playwright/test';
import { resolve } from 'node:path';
import { pinnedBrowser } from '../snapshotPaths';

/**
 * `test.use()` for a visual spec: connect to the pinned image's run-server when
 * OPENWOP_E2E_PINNED_WS names it (the browser reaches the runner's localhost
 * through Playwright's loopback exposure); otherwise the local browser.
 */
export function pinnedConnectOptions(): { connectOptions?: { wsEndpoint: string; exposeNetwork: string } } {
  const ws = process.env.OPENWOP_E2E_PINNED_WS;
  return ws ? { connectOptions: { wsEndpoint: ws, exposeNetwork: '<loopback>' } } : {};
}

/**
 * The visual specs' platform guard (ADR 0863 D9 P5). A pixel compare is only
 * meaningful against baselines recorded by the SAME renderer:
 *   - a local browser on darwin -> the committed `-darwin` set;
 *   - the version-pinned Playwright image's browser (any runner OS) -> `-pinned`,
 *     and the connected browser must be the one e2e/pinned-browser.json names.
 * Anything else fails BEFORE comparing, with the remedy named, and never skips
 * silently (the ci.sh browser-lane rule).
 */
export function assertVisualRenderer(browser: Browser, spec: string): void {
  // Playwright's cwd is frontend/react (the same fallback playwright.config.ts uses).
  const pinned = pinnedBrowser(resolve(process.cwd(), 'e2e'));
  if (pinned !== undefined) {
    if (browser.version() !== pinned.browserVersion) {
      throw new Error(`${spec}: the remote browser is ${browser.version()}, not the pinned ${pinned.browserVersion} `
        + `(${pinned.image}@${pinned.digest}). `
        + 'Point OPENWOP_E2E_PINNED_WS at the pinned image\'s run-server (scripts/e2e-pinned-baselines.sh).');
    }
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error(`${spec}: baselines exist for darwin (local browser) and for the PINNED Playwright image. `
      + 'On this platform, run against the pinned image\'s browser (OPENWOP_E2E_PINNED_WS; e2e/pinned-browser.json; '
      + 'scripts/e2e-pinned-baselines.sh) — do NOT run --update-snapshots ad hoc; an unreviewed baseline makes the '
      + 'visual gate certify whatever this machine happens to render.');
  }
}
