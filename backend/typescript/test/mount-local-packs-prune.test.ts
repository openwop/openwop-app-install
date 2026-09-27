/**
 * `ensureLocalPacksMounted` prunes symlinks whose source checkout is gone.
 *
 * THE OBSERVED FAILURE (2026-08-06). All 180 symlinks in a developer's
 * `~/.openwop-packs` were dangling at once — 174 of them left by a single
 * worktree removed minutes earlier. The mount's existing re-point branch only
 * heals packs THIS repo also has; a pack that lives solely in another checkout
 * leaves a link that outlives it, because nothing ever revisits it.
 *
 * The consequence is not a missing pack, it is a LYING one: the namespace
 * reports the pack as installed, and every non-vitest boot that reads it fails
 * against a path that no longer exists — which reads as a corrupt install rather
 * than a stale link. (Vitest itself is unaffected; `test/setup/isolatePackDir.ts`
 * gives every worker its own dir, which is precisely why this survived so long
 * without a red test.)
 *
 * A dangling symlink is useless by definition, so pruning cannot lose data. The
 * assertions below are therefore about what it must NOT touch.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLocalPacksMounted } from '../src/bootstrap/mountLocalPacks.js';

const made: string[] = [];
const savedEnv = { local: process.env.OPENWOP_LOCAL_PACKS_DIR, dest: process.env.OPENWOP_PACK_DIR };

/**
 * Drive the real entry point through its documented env overrides rather than
 * adding parameters for the test's convenience — a signature that exists only
 * for tests is a second code path, and this function's whole risk is what it
 * does to a REAL directory.
 */
function mount(localDir: string, destDir: string) {
  process.env.OPENWOP_LOCAL_PACKS_DIR = localDir;
  process.env.OPENWOP_PACK_DIR = destDir;
  return ensureLocalPacksMounted();
}
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  // Leaking OPENWOP_PACK_DIR across files is a documented way to break the
  // suite (#3008 fixed three tests doing exactly that).
  if (savedEnv.local === undefined) delete process.env.OPENWOP_LOCAL_PACKS_DIR;
  else process.env.OPENWOP_LOCAL_PACKS_DIR = savedEnv.local;
  if (savedEnv.dest === undefined) delete process.env.OPENWOP_PACK_DIR;
  else process.env.OPENWOP_PACK_DIR = savedEnv.dest;
});

/** A minimal pack directory the mounter will recognise. */
function pack(root: string, name: string): string {
  const p = join(root, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'pack.json'), JSON.stringify({ name, version: '1.0.0' }));
  return p;
}

describe('ensureLocalPacksMounted — dangling-mount prune', () => {
  it('removes a symlink whose target no longer exists', () => {
    const localDir = tmp('owp-src-');
    const destDir = tmp('owp-dest-');
    // A pack that exists ONLY in a checkout we are about to delete — the case
    // the re-point branch cannot reach, because this repo has no such pack.
    const gone = tmp('owp-other-');
    const orphanSrc = pack(gone, 'vendor.other.only-there');
    symlinkSync(orphanSrc, join(destDir, 'vendor.other.only-there'), 'dir');
    rmSync(gone, { recursive: true, force: true });

    // Fixture guard: the link must be dangling BEFORE the mount runs, or this
    // test proves nothing about pruning.
    const link = join(destDir, 'vendor.other.only-there');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(link), 'the fixture link was not actually dangling').toBe(false);

    const res = mount(localDir, destDir);
    expect(res.pruned).toContain('vendor.other.only-there');
    expect(lstatSync(link, { throwIfNoEntry: false }), 'the dangling link survived').toBeUndefined();
  });

  it('does NOT touch a symlink that still resolves', () => {
    const localDir = tmp('owp-src-');
    const destDir = tmp('owp-dest-');
    const liveSrc = pack(tmp('owp-live-'), 'vendor.other.alive');
    symlinkSync(liveSrc, join(destDir, 'vendor.other.alive'), 'dir');

    const res = mount(localDir, destDir);
    expect(res.pruned ?? []).not.toContain('vendor.other.alive');
    expect(existsSync(join(destDir, 'vendor.other.alive'))).toBe(true);
  });

  it('does NOT touch a REAL directory — a registry install is not a mount', () => {
    // The prune tests `symlinkTarget(...) !== null` first. A registry-installed
    // pack is a real directory; deleting one would destroy a signed artifact
    // this function is explicitly not allowed to clobber.
    const localDir = tmp('owp-src-');
    const destDir = tmp('owp-dest-');
    pack(destDir, 'core.openwop.registry-installed');

    const res = mount(localDir, destDir);
    expect(res.pruned ?? []).not.toContain('core.openwop.registry-installed');
    expect(existsSync(join(destDir, 'core.openwop.registry-installed', 'pack.json'))).toBe(true);
  });

  it('prunes the dangling one while mounting this repo’s packs in the same pass', () => {
    // The two behaviours share a loop over the destination dir; a prune that
    // ran before mounting, or that consumed entries the mounter needed, would
    // show up here and nowhere else.
    const localDir = tmp('owp-src-');
    pack(localDir, 'feature.mine.nodes');
    const destDir = tmp('owp-dest-');
    const gone = tmp('owp-other-');
    symlinkSync(pack(gone, 'vendor.other.only-there'), join(destDir, 'vendor.other.only-there'), 'dir');
    rmSync(gone, { recursive: true, force: true });

    const res = mount(localDir, destDir);
    expect(res.mounted).toContain('feature.mine.nodes');
    expect(res.pruned).toContain('vendor.other.only-there');
  });
});
