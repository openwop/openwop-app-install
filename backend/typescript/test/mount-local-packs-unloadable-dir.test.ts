/**
 * `ensureLocalPacksMounted` replaces a registry pack dir that has no readable
 * manifest — the case that could never repair itself.
 *
 * THE OBSERVED FAILURE (2026-08-13). `~/.openwop-packs/core.openwop.ai` was a
 * real directory containing ONLY `.openwop-installed.json`: no `pack.json`, no
 * `index.mjs`. That pack provides `core.ai.structuredOutput`, the single node
 * in every `conformance-envelope-*` fixture, so eight conformance scenarios
 * failed for want of a node type — and were quarantined (ADR 0550 P1) as
 * "pre-existing failure on main, not diagnosed", which reads as host
 * non-conformance. It was not. MEASURED: with the vendored packs mounted, 43
 * files / 207 tests pass and 0 fail; against the broken directory, 8 files /
 * 26 tests fail. Same commit.
 *
 * WHY IT COULD NOT HEAL. `shouldShadow()` returns false when either side's
 * version is unreadable, and `readManifestVersion()` returns null for a missing
 * or corrupt `pack.json`. So the shadow branch declined, the
 * `existsSync(dest)` branch skipped, and the vendored copy stayed blocked
 * forever. The pack was dead until a human deleted the directory — and nothing
 * told them to, because the namespace still LISTED the pack.
 *
 * This is the sibling of the dangling-symlink case in
 * `mount-local-packs-prune.test.ts`: both are directory states that report a
 * pack as installed while nothing loadable is there.
 *
 * The assertions below are about what the repair must NOT do: it must not touch
 * a dir that has a readable manifest (that is a real install, and shadowing it
 * stays version-gated), and it must not fire merely because a version is older.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLocalPacksMounted } from '../src/bootstrap/mountLocalPacks.js';

const made: string[] = [];
const savedEnv = {
  local: process.env.OPENWOP_LOCAL_PACKS_DIR,
  dest: process.env.OPENWOP_PACK_DIR,
  strict: process.env.OPENWOP_STRICT_REGISTRY,
};

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
  // Leaking OPENWOP_PACK_DIR across files breaks later files in the same worker
  // (test/setup/isolatePackDir.ts tripwire).
  if (savedEnv.local === undefined) delete process.env.OPENWOP_LOCAL_PACKS_DIR;
  else process.env.OPENWOP_LOCAL_PACKS_DIR = savedEnv.local;
  if (savedEnv.dest === undefined) delete process.env.OPENWOP_PACK_DIR;
  else process.env.OPENWOP_PACK_DIR = savedEnv.dest;
  if (savedEnv.strict === undefined) delete process.env.OPENWOP_STRICT_REGISTRY;
  else process.env.OPENWOP_STRICT_REGISTRY = savedEnv.strict;
});

/** A pack the mounter recognises (prefix must match the default allowlist). */
function pack(root: string, name: string, version = '1.0.0'): string {
  const p = join(root, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'pack.json'), JSON.stringify({ name, version }));
  writeFileSync(join(p, 'index.mjs'), 'export const nodes = {};\n');
  return p;
}

/** The rubble: an install marker and nothing else. Exactly what was on disk. */
function unloadableInstall(destDir: string, name: string): string {
  const p = join(destDir, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, '.openwop-installed.json'), JSON.stringify({ name, version: '1.0.0' }));
  return p;
}

const NAME = 'core.openwop.probe';

describe('ensureLocalPacksMounted — unloadable registry dir', () => {
  it('replaces a dir with no pack.json with the vendored copy', () => {
    const localDir = tmp('owp-src-');
    const destDir = tmp('owp-dest-');
    pack(localDir, NAME);
    const rubble = unloadableInstall(destDir, NAME);

    // Fixture guard: the destination must genuinely be unloadable BEFORE the
    // mount, or this proves nothing.
    expect(existsSync(join(rubble, 'pack.json'))).toBe(false);

    const res = mount(localDir, destDir);

    expect(res.mounted).toContain(NAME);
    expect(lstatSync(join(destDir, NAME)).isSymbolicLink()).toBe(true);
    // The pack is now actually loadable — the property the whole thing is for.
    const manifest = JSON.parse(readFileSync(join(destDir, NAME, 'pack.json'), 'utf-8')) as { name: string };
    expect(manifest.name).toBe(NAME);
  });

  it('replaces a dir whose pack.json is corrupt, not merely absent', () => {
    const localDir = tmp('owp-src-');
    const destDir = tmp('owp-dest-');
    pack(localDir, NAME);
    const rubble = unloadableInstall(destDir, NAME);
    writeFileSync(join(rubble, 'pack.json'), '{ this is not json');

    const res = mount(localDir, destDir);
    expect(res.mounted).toContain(NAME);
    const manifest = JSON.parse(readFileSync(join(destDir, NAME, 'pack.json'), 'utf-8')) as { name: string };
    expect(manifest.name).toBe(NAME);
  });

  it('repairs even under OPENWOP_STRICT_REGISTRY=true', () => {
    // Strict mode means "prefer the signed registry copy", not "keep an
    // unloadable one". If the repair were gated on preferLocal, production —
    // the posture DEPLOY.md documents — would be the one deployment that could
    // never heal, which is exactly backwards.
    process.env.OPENWOP_STRICT_REGISTRY = 'true';
    const localDir = tmp('owp-src-');
    const destDir = tmp('owp-dest-');
    pack(localDir, NAME);
    unloadableInstall(destDir, NAME);

    const res = mount(localDir, destDir);
    expect(res.mounted).toContain(NAME);
  });

  it('does NOT touch a registry dir that has a readable manifest', () => {
    // The guard that keeps this from becoming "the mount clobbers installs".
    // A real install with a NEWER version must survive untouched, even though
    // a local copy exists.
    const localDir = tmp('owp-src-');
    const destDir = tmp('owp-dest-');
    pack(localDir, NAME, '1.0.0');
    const installed = pack(destDir, NAME, '9.9.9');
    writeFileSync(join(installed, '.openwop-installed.json'), JSON.stringify({ name: NAME, version: '9.9.9' }));

    const res = mount(localDir, destDir);

    expect(res.mounted).not.toContain(NAME);
    expect(lstatSync(join(destDir, NAME)).isSymbolicLink()).toBe(false);
    const manifest = JSON.parse(readFileSync(join(destDir, NAME, 'pack.json'), 'utf-8')) as { version: string };
    expect(manifest.version, 'the newer registry install must survive').toBe('9.9.9');
  });

  it('leaves the normal version-gated shadow path intact', () => {
    // An OLDER readable install still goes through `shouldShadow`, is preserved
    // as `<name>.registry-<version>`, and is reported as shadowed — not mounted.
    // If the new branch had swallowed this case, the recoverable copy would be
    // deleted instead of parked.
    const localDir = tmp('owp-src-');
    const destDir = tmp('owp-dest-');
    pack(localDir, NAME, '2.0.0');
    pack(destDir, NAME, '1.0.0');

    const res = mount(localDir, destDir);

    expect(res.shadowed).toContain(NAME);
    expect(res.mounted).not.toContain(NAME);
    expect(existsSync(join(destDir, `${NAME}.registry-1.0.0`))).toBe(true);
  });
});
