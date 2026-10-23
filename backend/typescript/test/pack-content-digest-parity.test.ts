/**
 * ADR 0555 P0 — the pack content digest is implemented TWICE, and this is what
 * stops the two copies from drifting.
 *
 *   backend/typescript/src/packs/packContentDigest.ts   (runtime classifier)
 *   scripts/lib/pack-content-digest.mjs                 (manifest generator)
 *
 * Two copies exist because the generator runs in `scripts/ci.sh` BEFORE the
 * backend build, so it cannot import the compiled module, and the backend
 * bundle must not reach up into `scripts/`.
 *
 * Drift here is not cosmetic. The runtime compares its digest against the
 * digest the generator committed; if the two algorithms disagree by so much as
 * a separator byte, EVERY pack fails steward attestation simultaneously and the
 * fail-closed policy stops the whole product dispatching. That is a
 * self-inflicted outage triggered by an innocuous-looking refactor of either
 * file, which is precisely the kind of coupling a comment cannot enforce.
 *
 * So: identical output over fixtures that exercise every branch of the walk.
 * The fixture holds every entry KIND (file `f`, symlink `l`, fifo `o`) and
 * every EXCLUDED name (`.openwop-installed.json`, `node_modules`, `.git`,
 * `.DS_Store`), and case 2 asserts the fixture really does, so dropping an
 * exclusion or a kind from either copy is a red (probe 8fw1g1-dig-mjs-nodemod).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packContentDigest as tsDigest, listPackEntries as tsEntries } from '../src/packs/packContentDigest.js';
// The generator's copy, imported as the generator imports it.
import {
  packContentDigest as mjsDigest,
  listPackEntries as mjsEntries,
} from '../../../scripts/lib/pack-content-digest.mjs';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owp-digest-parity-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Every branch of the walk: nested dirs, a symlink, every excluded name, an
 *  empty dir, a fifo (the `o` kind), unicode + spaces in a filename, and a file
 *  whose bytes are not valid UTF-8 (so a copy that reads as text instead of
 *  bytes diverges). */
function writeExhaustiveFixture(dir: string): void {
  mkdirSync(join(dir, 'lib', 'nested'), { recursive: true });
  mkdirSync(join(dir, 'empty-dir'), { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({ name: 'x.y.z', version: '1.0.0' }));
  writeFileSync(join(dir, 'index.mjs'), 'export const nodes = {};\n');
  writeFileSync(join(dir, 'lib', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'lib', 'nested', 'b.mjs'), 'export const b = 2;\n');
  writeFileSync(join(dir, 'name with spaces and ünïcode.txt'), 'hello\n');
  writeFileSync(join(dir, 'binary.bin'), Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a]));
  // Excluded by name — both copies must skip it, or the marker's own presence
  // would change the digest it is compared against.
  writeFileSync(join(dir, '.openwop-installed.json'), '{"contentHashes":{}}');
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, '.DS_Store'), Buffer.from([0x00, 0x00, 0x00, 0x01]));
  // Neither a file, a dir nor a link: the `o` (other) kind. mkfifo exists on
  // macOS and Linux, the two platforms this suite runs on.
  execFileSync('mkfifo', [join(dir, 'pipe')]);
  symlinkSync('./lib/a.mjs', join(dir, 'link-to-a.mjs'));
  symlinkSync('/nonexistent/target', join(dir, 'dangling-link'));
}

describe('pack content digest — TS and .mjs implementations agree', () => {
  it('produce identical digests over an exhaustive fixture', () => {
    writeExhaustiveFixture(root);
    expect(mjsDigest(root)).toBe(tsDigest(root));
  });

  it('produce identical ENTRY LISTS, not just a colliding final hash', () => {
    // Comparing only the fold would let two different walks agree by accident
    // on one fixture. Compare the intermediate structure too.
    writeExhaustiveFixture(root);
    const entries = tsEntries(root);
    expect(mjsEntries(root)).toEqual(entries);

    // Anti-vacuity for the FIXTURE: it must reach the `o` kind and must hold
    // the excluded names, or the parity above proves nothing about them.
    expect(entries.filter((e) => e.kind === 'o').map((e) => e.path)).toEqual(['pipe']);
    expect(entries.some((e) => e.kind === 'l')).toBe(true);
    const excludedSeen = entries.filter((e) =>
      e.path === '.openwop-installed.json' || e.path === '.DS_Store'
      || e.path.startsWith('node_modules/') || e.path.startsWith('.git/'));
    expect(excludedSeen).toEqual([]);
  });

  it('agree that an empty directory has a stable digest', () => {
    expect(mjsDigest(root)).toBe(tsDigest(root));
  });

  it('agree on a missing directory (both fail closed, neither throws)', () => {
    const missing = join(root, 'does-not-exist');
    expect(() => tsDigest(missing)).not.toThrow();
    expect(mjsDigest(missing)).toBe(tsDigest(missing));
  });

  it('both track a change to ANY file, and still agree afterwards', () => {
    writeExhaustiveFixture(root);
    const before = tsDigest(root);
    writeFileSync(join(root, 'lib', 'nested', 'b.mjs'), 'export const b = 3;\n');
    const after = tsDigest(root);
    expect(after).not.toBe(before);
    expect(mjsDigest(root)).toBe(after);
  });

  it('both hash a symlink by its TARGET STRING, not the target content', () => {
    // If either copy followed the link, a pack could point at a file outside
    // itself and inherit that file's identity. Two links to different targets
    // whose contents would be identical (both unreadable) must still differ.
    mkdirSync(join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'b'), { recursive: true });
    symlinkSync('/nonexistent/one', join(root, 'a', 'l'));
    symlinkSync('/nonexistent/two', join(root, 'b', 'l'));
    expect(tsDigest(join(root, 'a'))).not.toBe(tsDigest(join(root, 'b')));
    expect(mjsDigest(join(root, 'a'))).toBe(tsDigest(join(root, 'a')));
    expect(mjsDigest(join(root, 'b'))).toBe(tsDigest(join(root, 'b')));
  });
});
