import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the visual baselines live: upstream's `e2e/<spec>-snapshots/`, or an
 * ADOPTER-OWNED `e2e/brand-snapshots/` when that directory exists.
 *
 * A white-label adopter rebrands the UI (its own `brand.css`), so upstream's
 * screenshots are the wrong baselines for it: MEASURED 2026-10-26, KickTodo's
 * blue UI failed 19 of 21 snapshot specs against the synced terracotta images.
 * Regenerating them IN PLACE made 36 upstream-owned PNGs adopter-modified, and
 * every sync that touches a screenshot then conflicts on it. Upstream never
 * writes `brand-snapshots/`, so a baseline kept there costs the adopter nothing
 * at merge time.
 *
 * All or nothing: when the directory exists, EVERY baseline is read from it.
 * With `updateSnapshots: 'none'` a missing brand baseline fails, which is right.
 * Silently falling back to upstream's image would compare the adopter's UI
 * against the wrong brand again.
 */
export const BRAND_SNAPSHOT_DIR = 'brand-snapshots';

/**
 * ADR 0863 D9 P5 — pixels come from the BROWSER, not the test runner. When the
 * browser is the version-pinned Playwright image's `run-server`, named by
 * `OPENWOP_E2E_PINNED_WS`, baselines are keyed by that rendering
 * environment (`-pinned`), not by the runner's OS. A Mac runner driving the
 * pinned container then records exactly what the Linux gate VM compares against,
 * and the `-darwin` set stays the local-browser baseline. The pinned renderer is
 * described ONCE, in e2e/pinned-browser.json; the visual specs refuse a connected
 * browser whose version differs (e2e/support/visualGuard.ts).
 *
 * ONLY the visual specs connect to it (visualGuard's `pinnedConnectOptions`, via
 * test.use). A global PW_TEST_CONNECT_WS_ENDPOINT moved every e2e test into the
 * container, and the egress specs (WebRTC, self-navigation to the runner's sinks)
 * went red on the gate VM for a reason that is the container's, not the app's
 * (shadow 9, 2026-11-02).
 */
export const PINNED_SUFFIX = 'pinned';
export interface PinnedBrowser { image: string; digest: string; playwright: string; browserVersion: string }
export function pinnedBrowser(e2eDir: string, env: NodeJS.ProcessEnv = process.env): PinnedBrowser | undefined {
  if (!env.OPENWOP_E2E_PINNED_WS) return undefined;
  return JSON.parse(readFileSync(join(e2eDir, 'pinned-browser.json'), 'utf8')) as PinnedBrowser;
}

/** The `snapshotPathTemplate` for an e2e dir, or undefined for Playwright's default. */
export function snapshotPathTemplate(e2eDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const brand = existsSync(join(e2eDir, BRAND_SNAPSHOT_DIR));
  const pinned = pinnedBrowser(e2eDir, env) !== undefined;
  if (!brand && !pinned) return undefined;
  // Same layout as the default (`<spec>-snapshots/<name>-<project>-<platform>.png`);
  // a brand set sits one level down, so an adopter can move its baselines across
  // unchanged. A pinned renderer replaces only the platform suffix.
  const dir = brand ? `{testDir}/${BRAND_SNAPSHOT_DIR}/{testFilePath}-snapshots` : '{snapshotDir}/{testFileDir}/{testFileName}-snapshots';
  return `${dir}/{arg}{-projectName}${pinned ? `-${PINNED_SUFFIX}` : '{-snapshotSuffix}'}{ext}`;
}
