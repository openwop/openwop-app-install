import { existsSync } from 'node:fs';
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

/** The `snapshotPathTemplate` for an e2e dir, or undefined for Playwright's default. */
export function snapshotPathTemplate(e2eDir: string): string | undefined {
  if (!existsSync(join(e2eDir, BRAND_SNAPSHOT_DIR))) return undefined;
  // Same layout as the default (`<spec>-snapshots/<name>-<project>-<platform>.png`),
  // one level down, so an adopter can move its baselines across unchanged.
  return `{testDir}/${BRAND_SNAPSHOT_DIR}/{testFilePath}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}`;
}
