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

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDefaultPackDir } from '../../packs/registryInstaller.js';
import { isTombstoned } from '../../host/packTombstones.js';
import { OpenwopError } from '../../types.js';
// Import-cycle note: index.ts → marketplace/feature.ts → routes.ts → this module,
// and this module reads BACKEND_FEATURES from index.ts. The cycle is SAFE because
// the binding is only dereferenced inside `listListings()` (call time), never at
// module-eval time — ESM live bindings resolve it by then.
import { BACKEND_FEATURES } from '../index.js';
import { isParkedPackDirName } from '../../bootstrap/mountLocalPacks.js';
import { classifyPackDir, type PackTrustTier } from '../../host/packTrust.js';

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
  /** SHA-256 SRI from the install marker — only while the install still verifies
   *  (`trust.tier === 'operator-trusted'`). */
  integrity?: string;
  /** Signing key id from the install marker — same condition as `integrity`. */
  publicKeyRef?: string;
  /** True when a registry install marker (`.openwop-installed.json`) is PRESENT.
   *  Presence only — it says nothing about whether the install still verifies;
   *  `trust` is the answer to that (ADR 0826 D6, `MKT2-27`). */
  installed: boolean;
  /** ADR 0826 D6 — the pack's trust tier from `host/packTrust.classifyPackDir`,
   *  the SOLE authority on whether its code may run. `integrity`/`publicKeyRef`
   *  are present only when this is `operator-trusted` (a verified install). */
  trust: { tier: PackTrustTier; reason: string };
  /**
   * MKT2-B2 — where the pack CAME FROM, which `installed` does not say.
   *
   * `installed` means "has a registry install marker". It was being rendered as
   * "Not installed", which is a different claim and a false one for the packs
   * mounted from the checkout: the executor is actively loading and running
   * them. MEASURED on a dev host at the time of this change: 172 symlinked
   * packs with 0 markers, 64 real directories with 64 markers — the split is
   * exact, which is why the dirent's symlink bit is the discriminator.
   *
   * It also decides whether Install can possibly work. `installPackFromRegistry`
   * fetches `<registry>/v1/packs/<name>/-/<version>.json` first, and a pack that
   * was never published necessarily 404s there, so offering the action on a
   * `local` pack offers something that cannot succeed.
   */
  origin: 'registry' | 'local';
  /** True when the pack is tombstoned — removed from this host (ADR 0194 P4);
   *  shown with a 'removed' chip + Restore instead of being hidden. */
  tombstoned?: boolean;
  /** Feature ids whose `requiredPacks` pin this pack (uninstall would break them). */
  requiredBy?: string[];
  /** ADR 0385 P4 — optional paid-lane pricing, annotated per viewer by the
   *  registered provider (`listingPricingHook`); absent when no provider or the
   *  pack has no paid listing. */
  pricing?: import('./listingPricingHook.js').ListingPricing;
}

interface PackManifest {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  keywords?: string[];
  /** Agent manifests this pack ships (RFC 0003). RFC 0131 adds the explicit
   *  `role` (`skill`/`assistant`); when absent, a `handoff` on all of them ⇒ a Skill. */
  agents?: { handoff?: unknown; role?: unknown }[];
}

interface InstallMarker {
  name?: string;
  version?: string;
  integrity?: string;
  publicKeyRef?: string;
}

/** Coarse category — display only, never authority (ADR 0312).
 *  An agent pack whose agents are ALL composable Skills (task→return workers) is a
 *  **Skill**, not a named/assistant Agent — that's the taxonomy operators reason about.
 *
 *  RFC 0131 (`Accepted`) makes `AgentManifest.role` (`skill`/`assistant`) first-class
 *  and **explicit — never inferred**, so an explicit `role` is authoritative here: a
 *  `role: "assistant"` anywhere ⇒ the pack ships a named agent ("Agent"). When a manifest
 *  omits `role` (every pack on the wire today), we fall back to the Phase-0 all-`handoff`
 *  heuristic, so classification is byte-identical to before until packs adopt `role`. */
export function categoryOf(manifest: PackManifest): string {
  const name = manifest.name ?? '';
  if (name.includes('.agents')) {
    const agents = manifest.agents ?? [];
    if (agents.length === 0) return 'Agent'; // empty is not vacuously a Skill
    // Per-agent kind: explicit RFC 0131 `role` wins; absent ⇒ infer from `handoff`.
    // The pack is a Skill iff EVERY agent resolves to a skill.
    const allSkill = agents.every((a) => {
      if (a == null || typeof a !== 'object') return false;
      if (a.role === 'skill') return true; // explicit, authoritative
      if (a.role === 'assistant') return false; // explicit, authoritative
      return 'handoff' in a; // role absent ⇒ Phase-0 handoff heuristic
    });
    return allSkill ? 'Skill' : 'Agent';
  }
  if (name.includes('.nodes')) return 'Node pack';
  if (name.startsWith('feature.')) return 'Feature pack';
  return 'Pack';
}

/** A human title from `pack.json` keywords/name (display only). */
function titleOf(manifest: PackManifest): string {
  return manifest.name ?? 'Unknown pack';
}

/**
 * Build the listing projection. Scans the local pack dir once.
 *
 * Returns [] when the pack dir is ABSENT — a fresh host with no packs renders
 * empty rather than 500, mirroring `agentPackRegistry.scanLocalAgentPacks`.
 * That is the only empty this function is licensed to invent.
 *
 * UX_UPGRADE-marketplace R2 (MKT2-B1) — it used to `catch { return [] }` around
 * the directory read as well, which silently extended the absent-dir license to
 * EACCES, EMFILE, ENOTDIR and EIO: "the catalog could not be read" was rendered
 * as "the catalog is empty". That is not a cosmetic difference here, because
 * this function feeds FOUR lanes and is also the existence gate for writes:
 *
 *   - `GET /listings` answered 200 with an empty catalog;
 *   - the agent tool handed a model `{listings: []}` with no annotation, while
 *     BOTH of its other empty paths are annotated — the one empty a model could
 *     not tell from an answer was the one that was not an answer;
 *   - the workflow surface wrote an empty catalog into a run;
 *   - `getListing()` is `listListings().find(...)`, so every pack reported
 *     `not_found` and the enablement/remove/purge routes refused with a 404
 *     naming the wrong cause.
 *
 * R1 fixed this exact shape on the sibling screen (MKT-G1: "a thrown fetch was
 * folded into [], the LEGITIMATE billing-off shape") and recorded this screen as
 * CLEAN — because it read the frontend and not this file.
 *
 * So a read failure now THROWS. Callers that must not fail closed (the agent
 * tool) catch it and say so in the words they already use for their other
 * empties.
 */
export function listListings(): Listing[] {
  const packDir = resolveDefaultPackDir();
  if (!existsSync(packDir)) return [];

  // Which feature ids require which pack (name@version) — the uninstall guard.
  const requiredBy = requiredByIndex();

  let entries: Array<{ name: string; symlinked: boolean }> = [];
  try {
    entries = readdirSync(packDir, { withFileTypes: true })
      // Accept directories AND symlinks pointing at one — mountLocalPacks installs
      // `core.openwop.*` packs as symlinks, and `isDirectory()` is false for those
      // (the same trap that rendered the agent-pack page empty on Cloud Run).
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      // MKT2-B2 — keep the symlink bit from the dirent we already have. It is
      // the provenance discriminator (see `origin` below) and costs no syscall.
      .map((d) => ({ name: d.name, symlinked: d.isSymbolicLink() }))
      .filter((e) => !isParkedPackDirName(e.name));
  } catch (err) {
    // MKT2-B1 — a real read failure, said as one. NOT `[]`.
    throw new OpenwopError(
      'internal_error',
      'The installed-pack directory could not be read, so the catalog is unknown — this is not the same as the catalog being empty.',
      500,
      { packDir, reason: 'pack_dir_unreadable', cause: err instanceof Error ? err.message : String(err) },
    );
  }

  const out: Listing[] = [];
  for (const { name: dir, symlinked } of entries) {
    const listing = buildListing(packDir, dir, symlinked, requiredBy);
    if (listing) out.push(listing);
  }

  // Stable order: alphabetical by name (the page sorts/filters further client-side).
  return out.sort((a, b) => a.packName.localeCompare(b.packName));
}

/** `name@version` → the feature ids whose `requiredPacks` pin it. */
function requiredByIndex(): Map<string, Set<string>> {
  const requiredBy = new Map<string, Set<string>>();
  for (const feature of BACKEND_FEATURES) {
    for (const ref of feature.requiredPacks ?? []) {
      const key = `${ref.name}@${ref.version}`;
      if (!requiredBy.has(key)) requiredBy.set(key, new Set());
      requiredBy.get(key)!.add(feature.id);
    }
  }
  return requiredBy;
}

/** One pack dir → its listing, or null when it holds no usable `pack.json`. */
function buildListing(packDir: string, dir: string, symlinked: boolean, requiredBy: Map<string, Set<string>>): Listing | null {
  const manifestPath = join(packDir, dir, 'pack.json');
  if (!existsSync(manifestPath)) return null;
  let manifest: PackManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PackManifest;
  } catch {
    return null; // skip malformed pack.json rather than fail the whole list
  }
  if (!manifest.name || !manifest.version) return null;

  const marker = readMarker(join(packDir, dir, MARKER));
  const requirers = requiredBy.get(`${manifest.name}@${manifest.version}`);
  // ADR 0826 D6 — ask the ONE trust authority (memoised per dir), never infer
  // "verified" from a marker's presence (`MKT2-27`).
  const verdict = classifyPackDir(join(packDir, dir));

  const listing: Listing = {
    packName: manifest.name,
    version: manifest.version,
    title: titleOf(manifest),
    category: categoryOf(manifest),
    installed: marker !== null,
    trust: { tier: verdict.tier, reason: verdict.reason },
    origin: symlinked ? 'local' : 'registry',
    ...(isTombstoned(manifest.name) ? { tombstoned: true } : {}),
  };
  if (manifest.description) listing.description = manifest.description;
  if (manifest.author) listing.author = manifest.author;
  if (verdict.tier === 'operator-trusted') {
    if (marker?.integrity) listing.integrity = marker.integrity;
    if (marker?.publicKeyRef) listing.publicKeyRef = marker.publicKeyRef;
  }
  if (requirers && requirers.size > 0) listing.requiredBy = [...requirers].sort();
  return listing;
}

/**
 * A single listing by pack name (the reviews / enablement / remove routes use it
 * as an existence gate). `MKT2-28` — it used to be `listListings().find()`, a full
 * directory scan + N `JSON.parse` per call. Install and mount both name the dir
 * after the pack, so read that one dir; fall back to the scan only when its
 * manifest names a different pack (a hand-placed dir), so the answer is unchanged.
 */
export function getListing(packName: string): Listing | null {
  const packDir = resolveDefaultPackDir();
  if (isParkedPackDirName(packName)) return null;
  const dirPath = join(packDir, packName);
  let symlinked = false;
  try {
    symlinked = lstatSync(dirPath).isSymbolicLink();
  } catch {
    symlinked = false;
  }
  const direct = existsSync(dirPath) ? buildListing(packDir, packName, symlinked, requiredByIndex()) : null;
  if (direct?.packName === packName) return direct;
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

