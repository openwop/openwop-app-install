/**
 * ADR 1014 D1 — prior versions of an AGENT pack stay on disk.
 *
 * The live directory stays `<packDir>/<name>/` (the head), so every existing scan,
 * mount, trust check and tool is unchanged. When an install replaces a pack that
 * declares agents, the outgoing version is MOVED to
 * `<packDir>/.versions/<name>/<version>/`, marker and all, instead of deleted.
 * The leading dot keeps it out of every `readdirSync(packDir)` scan, and the
 * install marker (path-independent) keeps it under the same trust gate.
 *
 * Retention (ADR 1014 Q3): every version a deployment row names is kept, never
 * pruned (it is a rollback or canary target); of the rest, the newest ten.
 * Which versions rows name comes through a seam the agent-deployments feature
 * registers, so `packs/` never imports a feature (ADR 0001).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLogger } from '../observability/logger.js';

const log = createLogger('packs.agentPackArchive');

export const ARCHIVE_DIR = '.versions';
export const ARCHIVE_KEEP_NEWEST = 10;
const MARKER = '.openwop-installed.json';
/** A pack name or version used as a path segment: no separators, no dot-dot. */
const SEGMENT = /^[A-Za-z0-9@][A-Za-z0-9._@+-]{0,127}$/;

type PinnedVersions = (packName: string, agentIds: readonly string[]) => Promise<ReadonlySet<string>>;
let pinned: PinnedVersions | undefined;

type InstalledHook = (packName: string, version: string, agentIds: readonly string[]) => Promise<void>;
let installedHook: InstalledHook | undefined;

/** ADR 1014 D4 — the agent-deployments feature mints a `draft` row for a newly
 *  installed version of an agent a tenant already deploys. Called after a HEAD
 *  install (never an archive fetch); a failure is logged, never fails the install. */
export function setAgentPackInstalledHook(fn: InstalledHook | undefined): void {
  installedHook = fn;
}

export async function notifyAgentPackInstalled(packDir: string, packName: string, version: string): Promise<void> {
  if (!installedHook) return;
  const agentIds = agentIdsOf(join(packDir, packName));
  if (agentIds.length === 0) return;
  try {
    await installedHook(packName, version, agentIds);
  } catch (err) {
    log.warn('agent pack installed hook failed', { packName, version, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The agent-deployments feature registers which versions its rows still name. */
export function setArchivePinnedVersions(fn: PinnedVersions | undefined): void {
  pinned = fn;
}

export function isSafeSegment(s: string): boolean {
  return SEGMENT.test(s) && !s.includes('..');
}

export function archivedVersionDir(packDir: string, packName: string, version: string): string | null {
  if (!isSafeSegment(packName) || !isSafeSegment(version)) return null;
  return join(packDir, ARCHIVE_DIR, packName, version);
}

function agentIdsOf(dir: string): string[] {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf-8')) as { agents?: Array<{ agentId?: unknown }> };
    return Array.isArray(m.agents) ? m.agents.map((a) => a?.agentId).filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function installedVersion(dir: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(dir, MARKER), 'utf-8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Move the current install of `packName` into the archive when it declares agents
 * and is a different version from `incoming`. Returns true when it moved; the
 * caller then installs into an empty `<name>/`. A pack with no agents (or no
 * marker) is left for the caller to replace, exactly as before.
 */
export function archiveOutgoingAgentPack(packDir: string, packName: string, incoming: string): boolean {
  const live = join(packDir, packName);
  if (!existsSync(live)) return false;
  const version = installedVersion(live);
  if (version === null || version === incoming || agentIdsOf(live).length === 0) return false;
  const dest = archivedVersionDir(packDir, packName, version);
  if (dest === null) return false;
  mkdirSync(join(packDir, ARCHIVE_DIR, packName), { recursive: true });
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  renameSync(live, dest);
  log.info('archived outgoing agent pack version', { packName, version, incoming });
  return true;
}

/** Semver order where both parse, string order otherwise (newest last). */
function compareVersions(a: string, b: string): number {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (pa && pb) {
    for (let i = 1; i <= 3; i++) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d !== 0) return d;
    }
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * TST-FIA-GC1 — temp dirs a fetch in THIS process is still installing into. The prune
 * below runs inside that same install (`installPackFromRegistry` ends with it), and it
 * sweeps `.tmp-*` dirs by `Date.now() - mtime`. With the wall clock more than an hour
 * ahead of the file's mtime (a clock step, or a test clock shift) it deleted the
 * fetch's own temp dir mid-flight. A live dir is never swept, whatever the clocks say.
 * The pack dir is per instance, so another process's live dir is not in scope.
 */
const liveArchiveTemps = new Set<string>();

/** Mark `dir` as being installed into until the returned release is called. */
export function holdArchiveTemp(dir: string): () => void {
  const key = resolve(dir);
  liveArchiveTemps.add(key);
  return () => { liveArchiveTemps.delete(key); };
}

/** Drop archived versions beyond the newest ten that no deployment row names. */
export async function pruneAgentPackArchive(packDir: string, packName: string): Promise<string[]> {
  if (!isSafeSegment(packName)) return [];
  const root = join(packDir, ARCHIVE_DIR, packName);
  if (!existsSync(root)) return [];
  // A fetch that timed out can still finish into its hidden temp dir later: sweep
  // temp dirs older than an hour so they never accumulate.
  for (const e of readdirSync(root)) {
    if (!e.startsWith('.tmp-')) continue;
    if (liveArchiveTemps.has(resolve(join(root, e)))) continue; // a fetch is installing into it
    try {
      if (Date.now() - statSync(join(root, e)).mtimeMs > 3_600_000) rmSync(join(root, e), { recursive: true, force: true });
    } catch { /* gone already */ }
  }
  const versions = readdirSync(root).filter(isSafeSegment).sort(compareVersions);
  const keep = new Set(versions.slice(-ARCHIVE_KEEP_NEWEST));
  if (versions.length > keep.size) {
    let named: ReadonlySet<string> = new Set();
    try {
      // The head's agent ids name the same agents the archived versions carry.
      named = pinned ? await pinned(packName, agentIdsOf(join(packDir, packName))) : new Set();
    } catch (err) {
      // Unknown pins: keep everything rather than delete a rollback target.
      log.warn('archive prune skipped: pinned versions unreadable', { packName, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
    for (const v of named) keep.add(v);
  }
  const dropped = versions.filter((v) => !keep.has(v));
  for (const v of dropped) rmSync(join(root, v), { recursive: true, force: true });
  if (dropped.length > 0) log.info('pruned archived agent pack versions', { packName, dropped });
  return dropped;
}
