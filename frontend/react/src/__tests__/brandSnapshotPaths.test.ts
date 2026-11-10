import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_SNAPSHOT_DIR, pinnedBrowser, snapshotPathTemplate } from '../../e2e/snapshotPaths';

/**
 * Where Playwright reads visual baselines: the white-label baseline seam (fix
 * d8888718f, 2026-10-26) and the ADR 0863 D9 P5 pinned renderer.
 *
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
 * goes red. Also witnessed (w89): ignoring OPENWOP_E2E_PINNED_WS, keeping
 * {-snapshotSuffix} under a pinned browser, and a pinned Playwright version that
 * differs from the lockfile's each turn a case red.
 */
describe('e2e snapshot paths', () => {
  it('an e2e dir without brand-snapshots/ keeps the default', () => {
    expect(snapshotPathTemplate(mkdtempSync(join(tmpdir(), 'e2e-')), {})).toBeUndefined();
  });

  it('brand-snapshots/ present → every baseline is read from it, in the default layout', () => {
    const e2e = mkdtempSync(join(tmpdir(), 'e2e-'));
    mkdirSync(join(e2e, BRAND_SNAPSHOT_DIR));
    expect(snapshotPathTemplate(e2e, {})).toBe(
      '{testDir}/brand-snapshots/{testFilePath}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}',
    );
  });

  // ADR 0863 D9 P5: a remote browser from the pinned Playwright image keys its
  // baselines by that renderer (-pinned), not the runner's OS, so a Mac runner
  // and the Linux gate VM read and write the same files. Sabotage (witnessed):
  // keep {-snapshotSuffix} under a remote browser -> both pinned cases go red.
  const remote = { OPENWOP_E2E_PINNED_WS: 'ws://127.0.0.1:3000/' };
  function pinnedDir(): string {
    const e2e = mkdtempSync(join(tmpdir(), 'e2e-'));
    writeFileSync(join(e2e, 'pinned-browser.json'), JSON.stringify({ image: 'i', digest: 'sha256:d', playwright: '1.60.0', browserVersion: '1.2.3' }));
    return e2e;
  }

  it('a remote (pinned) browser keys baselines by the renderer, not the platform', () => {
    const e2e = pinnedDir();
    expect(snapshotPathTemplate(e2e, remote)).toBe('{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}-pinned{ext}');
    expect(pinnedBrowser(e2e, remote)?.browserVersion).toBe('1.2.3');
    expect(pinnedBrowser(e2e, {})).toBeUndefined();
  });

  it('a brand set under a pinned browser stays in brand-snapshots/, with the -pinned suffix', () => {
    const e2e = pinnedDir();
    mkdirSync(join(e2e, BRAND_SNAPSHOT_DIR));
    expect(snapshotPathTemplate(e2e, remote)).toBe('{testDir}/brand-snapshots/{testFilePath}-snapshots/{arg}{-projectName}-pinned{ext}');
  });

  it('this repo names exactly one pinned renderer, pinned by digest', () => {
    const repoE2e = join(__dirname, '..', '..', 'e2e');
    const p = pinnedBrowser(repoE2e, remote);
    expect(p?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p?.image).toMatch(/^mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-/);
    expect(p?.image).toContain(`v${p?.playwright}-`);
    // A Playwright upgrade must move the pinned image with it (regenerate + review).
    const lock = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package-lock.json'), 'utf8'));
    expect(p?.playwright).toBe(lock.packages['node_modules/@playwright/test'].version);
  });
});
