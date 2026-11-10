/**
 * ADR 1048 — the architect review's three unverified points about tooling that
 * an adopter pack meets, settled by test rather than by reading:
 *
 *   1. `required-packs-pin-parity` TOLERATES the pins-equality rule. That test
 *      compares each requiredPacks pin (adopter pins included, via ADR 1031's
 *      `pinnedPackRef`) to `pack.json` over the REAL tree; it is not re-checked
 *      here (an earlier copy of its predicate in this file could never fail).
 *      ADR 1048 adds a third party to the same pair — the adopter manifest's
 *      `version` must equal the pin. The table pins what the manifest rule alone
 *      refuses at each stage of a half-done bump: it accepts the consistent tree
 *      and the stage that is pin↔disk's to catch, and refuses exactly the stages
 *      where the manifest was not regenerated.
 *   2. `check-pack-pin-drift.mjs` and an adopter `vendor.<adopter>.*` pack: the
 *      `MANAGED` regex counts it as registry-managed, so it is VENDORED; it is
 *      compared only if production pins it. Unpinned (the normal adopter case)
 *      it can never fail the deploy gate; pinned below the vendored version it
 *      is drift like any registry pack.
 *   3. The white-label bundle guard refuses a tracked `packs/.adopter-manifest.json`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateAdopterManifest } from '../../../scripts/lib/adopter-pack-manifest.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'owp-1048-tooling-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('1. the pins-equality rule refuses exactly the manifest-not-regenerated half (pin↔disk is required-packs-pin-parity\'s)', () => {
  const K = 'vendor.acme.nodes';
  const manifestOk = (pin: string, manifestVersion: string): boolean => validateAdopterManifest(
    { version: 1, packs: { [K]: { version: manifestVersion, files: 1, digest: 'd', declared: [], served: [], held: {} } } },
    { stewardKeys: new Set(), pins: { [K]: pin }, upstreamDeclared: new Set(), packNameOf: (d) => d },
  ).length === 0;

  it.each([
    // [state,                                  pin,     manifest, manifest rule]   (disk, for the reader)
    ['consistent',                              '1.2.0', '1.2.0',  true],           // disk 1.2.0
    ['pack bumped, pin + manifest not',         '1.2.0', '1.2.0',  true],           // disk 1.3.0 — parity's half (and --check: digest drift)
    ['pack + pin bumped, manifest not regen',   '1.3.0', '1.2.0',  false],          // disk 1.3.0 — the manifest rule's half
    ['pin bumped alone',                        '1.3.0', '1.2.0',  false],          // disk 1.2.0
  ])('%s', (_s, pin, manifest, expectManifest) => {
    expect(manifestOk(pin, manifest)).toBe(expectManifest);
  });
});

describe('2. check-pack-pin-drift treats an adopter vendor.* pack as vendored, compared only when pinned', () => {
  function tree(): string {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    cpSync(join(REPO, 'scripts', 'check-pack-pin-drift.mjs'), join(root, 'scripts', 'check-pack-pin-drift.mjs'));
    for (const [name, version] of [['core.openwop.ai', '1.3.2'], ['vendor.bookai.author-suite.nodes', '0.1.43']] as const) {
      mkdirSync(join(root, 'packs', name), { recursive: true });
      writeFileSync(join(root, 'packs', name, 'pack.json'), JSON.stringify({ name, version }));
    }
    const known = join(root, 'known.json');
    writeFileSync(known, JSON.stringify({ unshipped: [] }));
    return known;
  }
  const run = (pins: string, known: string): { code: number; out: string } => {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'check-pack-pin-drift.mjs'), '--pins', pins], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', OPENWOP_PIN_DRIFT_KNOWN_FILE: known },
    });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };

  it('unpinned adopter pack: counted as vendored, never compared, never fails the gate', () => {
    const r = run('core.openwop.ai@1.3.2', tree());
    expect(r.code).toBe(0);
    expect(r.out).toContain('2 vendored packs, 1 pinned, none unshipped');
  });

  it('pinned below its vendored version: drift, exactly like any registry pack', () => {
    const r = run('core.openwop.ai@1.3.2,vendor.bookai.author-suite.nodes@0.1.40', tree());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NEW\s+vendor\.bookai\.author-suite\.nodes — vendored 0\.1\.43, production pinned 0\.1\.40/);
  });
});

describe('3. the white-label bundle guard refuses a tracked adopter manifest', () => {
  function repo(withManifest: boolean): { code: number; out: string } {
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    cpSync(join(REPO, 'scripts', 'build-whitelabel-zip.sh'), join(root, 'scripts', 'build-whitelabel-zip.sh'));
    mkdirSync(join(root, 'packs'), { recursive: true });
    writeFileSync(join(root, 'packs', '.steward-manifest.json'), '{"version":1,"packs":{}}\n');
    if (withManifest) writeFileSync(join(root, 'packs', '.adopter-manifest.json'), '{"version":1,"packs":{}}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
    const r = spawnSync('bash', [join(root, 'scripts', 'build-whitelabel-zip.sh')], { cwd: root, encoding: 'utf8', env: { ...process.env, OUT_DIR: join(root, 'out') } });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  it('tracked packs/.adopter-manifest.json ⇒ FAIL before anything is archived', () => {
    const r = repo(true);
    expect(r.code).toBe(1);
    expect(r.out).toContain('adopter-owned path');
    expect(r.out).toContain('packs/.adopter-manifest.json');
    expect(r.out).not.toContain('archiving HEAD');
  });

  it('positive control: without it the guard passes and archiving starts', () => {
    const r = repo(false);
    expect(r.out).not.toContain('adopter-owned path');
    expect(r.out).toContain('archiving HEAD');
  });
});
