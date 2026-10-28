import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_SNAPSHOT_DIR, snapshotPathTemplate } from '../../e2e/snapshotPaths';

/**
 * A white-label adopter keeps its own visual baselines in e2e/brand-snapshots/,
 * so it never modifies upstream's PNGs (36 of them conflicted on every KickTodo
 * sync, 2026-10-26). Without that directory, Playwright's default paths stand.
 *
 * Every case uses a TEMP e2e dir, never this repo's own. An adopter's checkout
 * HAS e2e/brand-snapshots/ by design, so a case that asserted "this repo has
 * none" failed on KickTodo's first sync carrying this file (2026-10-27).
 *
 * Sabotage (witnessed): ignore the directory check → the "no brand dir" case
 * goes red; drop `{testFilePath}-snapshots` from the template → the layout case
 * goes red.
 */
describe('e2e snapshot paths', () => {
  it('an e2e dir without brand-snapshots/ keeps the default', () => {
    expect(snapshotPathTemplate(mkdtempSync(join(tmpdir(), 'e2e-')))).toBeUndefined();
  });

  it('brand-snapshots/ present → every baseline is read from it, in the default layout', () => {
    const e2e = mkdtempSync(join(tmpdir(), 'e2e-'));
    mkdirSync(join(e2e, BRAND_SNAPSHOT_DIR));
    expect(snapshotPathTemplate(e2e)).toBe(
      '{testDir}/brand-snapshots/{testFilePath}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}',
    );
  });
});
