/**
 * Canvas-content pack loader (ADR 0347 5a — CT-04/05). A HOST-PRIVATE pack
 * kind (`kind:"canvas-content"`): distributable multi-frame KITS (screens +
 * connectors + typed template variables) a canvas type's editor instantiates
 * into the ONE document. Follows the artifactTypePackLoader pattern — scan
 * roots, kind-filter, bounded validation, in-process registry — and the ADR
 * 0346 lessons: promotion of this kind to a normative cross-host contract is
 * an RFC first (the standing ADR 0342 watch-item); until then unrecognized
 * hosts simply kind-filter these packs out.
 *
 * Trust posture: in-tree/vendored packs are trusted source (the chain-pack
 * rule); registry installs ride the Ed25519/SRI-verified installer path.
 * Instantiation SAFETY is the editor's save-path validator — kit content is
 * ordinary closed-catalog document content, never code.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../observability/logger.js';
import { resolveDefaultPackDir } from '../packs/registryInstaller.js';
import { isTombstoned } from './packTombstones.js';
import { locateRepoDir } from './_repoPath.js';
import { isParkedPackDirName } from '../bootstrap/mountLocalPacks.js';

const log = createLogger('host.canvasContentPacks');

export interface CanvasKitVariable {
  name: string;
  type: 'string' | 'color';
  label?: string;
  default?: string;
  description?: string;
}
export interface CanvasKit {
  kitId: string;
  version: string;
  label: string;
  description?: string;
  canvasTypeId: string;
  variables?: CanvasKitVariable[];
  /** Frame fragments (the type's frames-trait shape, e.g. app-builder screens). */
  screens: Record<string, unknown>[];
  /** Type-specific relations between frames (app-builder connectors). */
  connectors?: Record<string, unknown>[];
  /** Catalog component types the kit uses — the editor can warn on a stale catalog. */
  catalogDependencies?: string[];
}

interface Registered { packName: string; packVersion: string; kit: CanvasKit }

const KITS = new Map<string, Registered>(); // kitId → entry

const MAX_KITS_PER_PACK = 20;
const MAX_SCREENS_PER_KIT = 20;
const MAX_VARIABLES = 12;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/; // template-var safety (the RFC 0124 lesson)
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function validKit(raw: unknown, errors: string[]): raw is CanvasKit {
  const k = raw as Partial<CanvasKit> | null;
  if (!k || typeof k !== 'object') { errors.push('kit must be an object'); return false; }
  if (typeof k.kitId !== 'string' || !ID_RE.test(k.kitId)) { errors.push('kitId must be an id slug'); return false; }
  if (typeof k.version !== 'string' || !k.version) { errors.push(`${k.kitId}: version required`); return false; }
  if (typeof k.label !== 'string' || !k.label) { errors.push(`${k.kitId}: label required`); return false; }
  if (typeof k.canvasTypeId !== 'string' || !k.canvasTypeId.startsWith('canvas.')) { errors.push(`${k.kitId}: canvasTypeId must be a canvas type`); return false; }
  if (!Array.isArray(k.screens) || k.screens.length < 1 || k.screens.length > MAX_SCREENS_PER_KIT) { errors.push(`${k.kitId}: screens must be 1..${MAX_SCREENS_PER_KIT}`); return false; }
  if (k.variables !== undefined) {
    if (!Array.isArray(k.variables) || k.variables.length > MAX_VARIABLES) { errors.push(`${k.kitId}: at most ${MAX_VARIABLES} variables`); return false; }
    for (const v of k.variables) {
      if (!v || typeof v.name !== 'string' || !NAME_RE.test(v.name)) { errors.push(`${k.kitId}: variable names must match ${String(NAME_RE)}`); return false; }
      if (v.type !== 'string' && v.type !== 'color') { errors.push(`${k.kitId}: variable '${v.name}' type must be string|color`); return false; }
    }
  }
  return true;
}

export interface CanvasContentLoadOutcome {
  installed: { packName: string; packVersion: string; kitIds: string[] }[];
  errors: { pack: string; code: string; message: string }[];
}

export function defaultCanvasContentPackRoots(): string[] {
  const roots: string[] = [];
  try {
    roots.push(locateRepoDir(new URL('.', import.meta.url).pathname, 'packs', 'core.openwop.artifact-types/pack.json'));
  } catch { /* outside the workspace (Cloud Run image) — registry dir below still applies */ }
  roots.push(resolveDefaultPackDir());
  if (process.env.OPENWOP_CANVAS_CONTENT_PACKS_DIR) roots.push(process.env.OPENWOP_CANVAS_CONTENT_PACKS_DIR);
  return [...new Set(roots)];
}

export function loadCanvasContentPacks(opts: { roots: string[] }): CanvasContentLoadOutcome {
  const outcome: CanvasContentLoadOutcome = { installed: [], errors: [] };
  // Grade pass 2026-07-11 (AB-DATA-3): the same pack readable via TWO roots
  // (repo `packs/` + the mounted pack dir) must register once — first root
  // wins, like `installRegistryPacks`' skip-on-disk rule. Without this the
  // boot outcome double-counted the pack.
  const seenPacks = new Set<string>();
  for (const root of opts.roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (isParkedPackDirName(dir)) continue;
      const packJson = join(root, dir, 'pack.json');
      try {
        if (!existsSync(packJson) || !statSync(join(root, dir)).isDirectory()) continue;
        const manifest = JSON.parse(readFileSync(packJson, 'utf8')) as { name?: string; version?: string; kind?: string; kits?: unknown[] };
        if (manifest.kind !== 'canvas-content') continue;
        const packName = typeof manifest.name === 'string' ? manifest.name : dir;
        if (seenPacks.has(packName)) continue;
        seenPacks.add(packName);
        if (isTombstoned(packName)) { log.info('canvas_content_pack_tombstoned', { pack: packName }); continue; }
        const kitsRaw = Array.isArray(manifest.kits) ? manifest.kits : [];
        if (kitsRaw.length > MAX_KITS_PER_PACK) {
          outcome.errors.push({ pack: packName, code: 'canvas_content_pack_invalid', message: `at most ${MAX_KITS_PER_PACK} kits per pack` });
          continue;
        }
        const errors: string[] = [];
        const kitIds: string[] = [];
        for (const raw of kitsRaw) {
          if (!validKit(raw, errors)) continue;
          const existing = KITS.get(raw.kitId);
          if (existing && existing.packName !== packName) {
            outcome.errors.push({ pack: packName, code: 'canvas_content_kit_conflict', message: `kit '${raw.kitId}' already registered by ${existing.packName}` });
            continue;
          }
          KITS.set(raw.kitId, { packName, packVersion: String(manifest.version ?? '0.0.0'), kit: raw });
          kitIds.push(raw.kitId);
        }
        if (errors.length) outcome.errors.push({ pack: packName, code: 'canvas_content_pack_invalid', message: errors.slice(0, 3).join('; ') });
        if (kitIds.length) outcome.installed.push({ packName, packVersion: String(manifest.version ?? '0.0.0'), kitIds });
      } catch (err) {
        outcome.errors.push({ pack: dir, code: 'canvas_content_pack_unreadable', message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return outcome;
}

/** The kits a canvas type's editor offers (the catalog route's additive field). */
export function kitsForCanvasType(canvasTypeId: string): CanvasKit[] {
  return [...KITS.values()].filter((r) => r.kit.canvasTypeId === canvasTypeId).map((r) => r.kit);
}

/** Full reload — clear-then-load, the `reloadWorkflowChainPacks` precedent
 *  (grade pass AB-DATA-3): without the clear, a kit REMOVED from a still-present
 *  pack would survive as a stale registry entry on any future reload path. */
export function reloadCanvasContentPacks(opts: { roots: string[] }): CanvasContentLoadOutcome {
  KITS.clear();
  return loadCanvasContentPacks(opts);
}

/** Test seam. */
export function _resetCanvasContentRegistryForTest(): void {
  KITS.clear();
}
