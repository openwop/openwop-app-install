/**
 * Node-pack resolver — wires the executor's NodeRegistry async miss
 * path to the pack-registry storage so packs registered after boot
 * can be loaded transparently.
 *
 * Sample-grade: scans `./packs/*.json` at boot for any pack manifests,
 * verifies SRI + Ed25519 signature where present, and registers their
 * node modules. Real deployers point at a real pack registry (the
 * postgres host's `pack-consumer.ts` is the reference).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setNodePackResolver } from '../executor/nodeRegistry.js';
import { loadPackFromManifest } from '../packs/tarballLoader.js';
import { resolveDefaultPackDir } from '../packs/registryInstaller.js';
import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';

const log = createLogger('bootstrap.nodePackResolver');
// MUST match `registryInstaller.resolveDefaultPackDir()` so the
// resolver looks in the same directory the installer writes to.
const PACK_DIR = resolveDefaultPackDir();

// ENG-8: a cached typeId → pack-dir index. The previous resolver re-read AND
// JSON.parsed every `pack.json` on EVERY registry miss (the executor's
// request-path miss handler), so an unknown typeId scanned the whole pack
// directory each time. We build the index once and rebuild it only when the
// SET of pack directories changes (a pack install/remove creates/drops a dir),
// turning each miss into an O(1) lookup. Caveat: an in-place manifest edit that
// keeps the same dir name (dev-only) won't be picked up until the dir set
// changes or the process restarts — acceptable, since real installs land new
// versioned dirs.
let cachedDirKey = '';
let typeIndex = new Map<string, string>(); // typeId → pack entry dir name

function buildTypeIndex(entries: readonly string[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const entry of entries) {
    const manifestPath = join(PACK_DIR, entry, 'pack.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (Array.isArray(manifest.nodes)) {
        for (const n of manifest.nodes) {
          if (n && typeof n.typeId === 'string' && !idx.has(n.typeId)) idx.set(n.typeId, entry);
        }
      }
    } catch (err) {
      log.warn('failed to scan pack manifest', {
        path: manifestPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return idx;
}

export function ensureNodePackResolverInstalled(_storage: Storage): void {
  setNodePackResolver(async (typeId) => {
    if (!existsSync(PACK_DIR)) return null;
    // readdirSync is cheap; the JSON.parse-per-manifest is what we cache.
    const entries = readdirSync(PACK_DIR).sort();
    const dirKey = entries.join('\n');
    if (dirKey !== cachedDirKey) {
      typeIndex = buildTypeIndex(entries);
      cachedDirKey = dirKey;
    }
    const entry = typeIndex.get(typeId);
    if (!entry) return null;
    return await loadPackFromManifest(join(PACK_DIR, entry));
  });
}
