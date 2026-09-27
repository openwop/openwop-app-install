/**
 * NODE-PACK-AUDIT tripwire — requiredPacks / binding pin ↔ pack.json version
 * parity, corpus-wide.
 *
 * Replay binds the PINNED pack version (RFC 0076), so a feature pin lagging a
 * pack bump silently fails to resolve at run time. This drift class recurred on
 * three consecutive audit passes (2026-06-23: 20 pins checked; 2026-07-17;
 * 2026-07-18: FOUR lagging pins — campaign-connectors, campaign-journeys,
 * commerce buyer, slides) before the 2026-07-21 pass found zero. The audit
 * named a permanent test the highest-leverage follow-up; this is it — the
 * manifest↔impl sibling of `pack-manifest-impl-parity.test.ts`.
 *
 * Method mirrors the audit's programmatic sweep: every `{ name: '<pack>',
 * version: '<semver>' }` literal in a feature source file whose `name` is a
 * pack that exists on disk MUST pin the version that pack's `pack.json`
 * ships. That covers `requiredPacks`, toggle `bindings`, and any other
 * version-bearing pack reference a feature declares.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '../../..');
const PACKS_DIR = join(REPO_ROOT, 'packs');
const FEATURES_DIR = join(REPO_ROOT, 'backend/typescript/src/features');

interface Pin {
  file: string;
  pack: string;
  pinned: string;
}

function packVersionsOnDisk(): Map<string, string> {
  const versions = new Map<string, string>();
  for (const entry of readdirSync(PACKS_DIR)) {
    const manifestPath = join(PACKS_DIR, entry, 'pack.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; version?: string };
    if (manifest.name && manifest.version) versions.set(manifest.name, manifest.version);
  }
  return versions;
}

function collectPins(diskVersions: Map<string, string>): Pin[] {
  const pins: Pin[] = [];
  const pinRe = /name:\s*['"]([a-z0-9.\-]+)['"]\s*,\s*version:\s*['"]([0-9][0-9a-z.\-]*)['"]/g;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else if (entry.endsWith('.ts')) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(pinRe)) {
          const [, name, version] = m;
          if (diskVersions.has(name)) pins.push({ file: relative(REPO_ROOT, p), pack: name, pinned: version });
        }
      }
    }
  };
  walk(FEATURES_DIR);
  return pins;
}

describe('pack pin ↔ disk version parity (NODE-PACK-AUDIT tripwire)', () => {
  const diskVersions = packVersionsOnDisk();
  const pins = collectPins(diskVersions);

  it('finds a plausible pin population (the scan itself must not rot)', () => {
    // 121 pins existed when this tripwire landed (2026-07-22). A floor well
    // below that tolerates refactors while still catching a regex/layout
    // change that silently empties the scan — an empty sweep would pass the
    // parity assertion below while checking nothing.
    expect(diskVersions.size).toBeGreaterThan(100);
    expect(pins.length).toBeGreaterThan(80);
  });

  it('every feature pin matches the pack version on disk (replay resolvability, RFC 0076)', () => {
    const drift = pins
      .filter((p) => diskVersions.get(p.pack) !== p.pinned)
      .map((p) => `${p.file}: pins ${p.pack}@${p.pinned} but disk ships ${diskVersions.get(p.pack)}`);
    expect(drift, drift.join('\n')).toEqual([]);
  });

  it('no two features pin the SAME pack at DIFFERENT versions', () => {
    // Even if disk moved and every pin were stale together, split pins are a
    // second, independent smell (two features cannot both be right).
    const byPack = new Map<string, Set<string>>();
    for (const p of pins) {
      byPack.set(p.pack, (byPack.get(p.pack) ?? new Set()).add(p.pinned));
    }
    const split = [...byPack.entries()]
      .filter(([, versions]) => versions.size > 1)
      .map(([pack, versions]) => `${pack} pinned at ${[...versions].join(' AND ')}`);
    expect(split, split.join('\n')).toEqual([]);
  });
});
