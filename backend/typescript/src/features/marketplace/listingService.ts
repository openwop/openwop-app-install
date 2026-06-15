/**
 * Marketplace listing projection (ADR 0022 Phase 1) — a READ-ONLY view over the
 * pack pipeline that already exists. A `Listing` is COMPUTED, never stored: scan
 * the local pack dir (the `nodeCatalog` / `agentPackRegistry` pattern) for
 * `pack.json` manifests, annotate each with install status from its
 * `.openwop-installed.json` trust marker, and cross-reference `featurePackRefs()`
 * to mark which features REQUIRE the pack (so a UI can warn before an uninstall).
 *
 * This module re-implements NONE of the pack pipeline: it reads the same on-disk
 * artifacts `registryInstaller` produces and `nodeCatalog` already scans. The
 * only NEW persistence in this feature is the reviews store (reviewService.ts).
 *
 * @see docs/adr/0022-marketplace.md
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDefaultPackDir } from '../../packs/registryInstaller.js';
// Import-cycle note: index.ts → marketplace/feature.ts → routes.ts → this module,
// and this module reads BACKEND_FEATURES from index.ts. The cycle is SAFE because
// the binding is only dereferenced inside `listListings()` (call time), never at
// module-eval time — ESM live bindings resolve it by then.
import { BACKEND_FEATURES } from '../index.js';

const MARKER = '.openwop-installed.json';

/** A computed marketplace listing — a projection, NOT a stored record. */
export interface Listing {
  /** Pack name, e.g. `feature.crm.nodes` or `core.openwop.agents.code-reviewer`. */
  packName: string;
  /** Pack version present on disk. */
  version: string;
  /** From `pack.json` (display only). */
  title: string;
  description?: string;
  author?: string;
  /** Coarse category derived from the pack namespace (node / agent / feature). */
  category: string;
  /** SHA-256 SRI from the install marker (verified at install time), when installed. */
  integrity?: string;
  /** Signing public-key ref from the install marker, when installed. */
  publicKeyRef?: string;
  /** True when a verified `.openwop-installed.json` marker is present. */
  installed: boolean;
  /** Feature ids whose `requiredPacks` pin this pack (uninstall would break them). */
  requiredBy?: string[];
}

interface PackManifest {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  keywords?: string[];
}

interface InstallMarker {
  name?: string;
  version?: string;
  integrity?: string;
  publicKeyRef?: string;
}

/** Coarse category from the pack namespace — display only, never authority. */
function categoryOf(name: string): string {
  if (name.includes('.agents')) return 'Agent pack';
  if (name.includes('.nodes')) return 'Node pack';
  if (name.startsWith('feature.')) return 'Feature pack';
  return 'Pack';
}

/** A human title from `pack.json` keywords/name (display only). */
function titleOf(manifest: PackManifest): string {
  return manifest.name ?? 'Unknown pack';
}

/**
 * Build the listing projection. Scans the local pack dir once. Returns [] (never
 * throws) when the dir is absent — a fresh host with no packs renders empty
 * rather than 500, mirroring `agentPackRegistry.scanLocalAgentPacks`.
 */
export function listListings(): Listing[] {
  const packDir = resolveDefaultPackDir();
  if (!existsSync(packDir)) return [];

  // Which feature ids require which pack (name@version) — the uninstall guard.
  const requiredBy = new Map<string, Set<string>>();
  for (const feature of BACKEND_FEATURES) {
    for (const ref of feature.requiredPacks ?? []) {
      const key = `${ref.name}@${ref.version}`;
      if (!requiredBy.has(key)) requiredBy.set(key, new Set());
      requiredBy.get(key)!.add(feature.id);
    }
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(packDir, { withFileTypes: true })
      // Accept directories AND symlinks pointing at one — mountLocalPacks installs
      // `core.openwop.*` packs as symlinks, and `isDirectory()` is false for those
      // (the same trap that rendered the agent-pack page empty on Cloud Run).
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const out: Listing[] = [];
  for (const dir of entries) {
    const manifestPath = join(packDir, dir, 'pack.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: PackManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PackManifest;
    } catch {
      continue; // skip malformed pack.json rather than fail the whole list
    }
    if (!manifest.name || !manifest.version) continue;

    const marker = readMarker(join(packDir, dir, MARKER));
    const reqKey = `${manifest.name}@${manifest.version}`;
    const requirers = requiredBy.get(reqKey);

    const listing: Listing = {
      packName: manifest.name,
      version: manifest.version,
      title: titleOf(manifest),
      category: categoryOf(manifest.name),
      installed: marker !== null,
    };
    if (manifest.description) listing.description = manifest.description;
    if (manifest.author) listing.author = manifest.author;
    if (marker?.integrity) listing.integrity = marker.integrity;
    if (marker?.publicKeyRef) listing.publicKeyRef = marker.publicKeyRef;
    if (requirers && requirers.size > 0) listing.requiredBy = [...requirers].sort();
    out.push(listing);
  }

  // Stable order: alphabetical by name (the page sorts/filters further client-side).
  return out.sort((a, b) => a.packName.localeCompare(b.packName));
}

/** A single listing by pack name (the reviews route validates the pack exists). */
export function getListing(packName: string): Listing | null {
  return listListings().find((l) => l.packName === packName) ?? null;
}

/** Read the verified install marker, or null when absent/corrupt (= not installed). */
function readMarker(markerPath: string): InstallMarker | null {
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, 'utf-8')) as InstallMarker;
  } catch {
    return null;
  }
}

