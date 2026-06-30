/**
 * Artifact-type pack loader (ADR 0055 Phase 3 / RFC 0075 `kind:'artifact-type'`).
 * Scans pack roots for `kind:'artifact-type'` manifests and registers their declared
 * types into the SAME host registry as native types (`registerArtifactType`,
 * `registrationSource:'pack'`) — no parallel registry. Mirrors the connection-pack
 * loader's posture: per-pack / per-type failures are ISOLATED (logged + collected,
 * never thrown) so one malformed pack can't abort boot.
 *
 * Manifest shape:
 *   { "name", "version", "kind": "artifact-type",
 *     "artifactTypes": [ { "artifactTypeId", "title?", "schema", "export?": string[] } ] }
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../observability/logger.js';
import { registerArtifactType, getArtifactType, type ArtifactType } from './artifactTypes.js';

const log = createLogger('host.artifactTypePackLoader');

export interface ArtifactTypePackOutcome {
  /** artifactTypeIds registered on this run. */
  registered: string[];
  /** Per-pack/per-type rejections (isolated; boot continues). */
  errors: Array<{ pack: string; message: string }>;
}

/** Default roots: the mounted/installed pack dir (`OPENWOP_PACK_DIR` or
 *  `~/.openwop-packs` — where mountLocalPacks symlinks the repo's vendored packs)
 *  plus an operator override. Non-existent roots are skipped. */
export function defaultArtifactTypePackRoots(): string[] {
  return [
    process.env.OPENWOP_PACK_DIR ?? join(homedir(), '.openwop-packs'),
    process.env.OPENWOP_ARTIFACT_TYPE_PACKS_DIR ?? '',
  ].filter((p) => p.length > 0);
}

export function loadArtifactTypePacks(opts: { roots: string[] }): ArtifactTypePackOutcome {
  const registered: string[] = [];
  const errors: ArtifactTypePackOutcome['errors'] = [];
  const seenPacks = new Set<string>();

  for (const root of opts.roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      let st;
      try { st = statSync(dir); } catch { continue; }
      const manifestPath = join(dir, 'pack.json');
      if (!st.isDirectory() || !existsSync(manifestPath)) continue;

      let raw: unknown;
      try { raw = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { continue; }
      if (!raw || typeof raw !== 'object' || (raw as { kind?: string }).kind !== 'artifact-type') continue;

      const packName = (raw as { name?: string }).name ?? entry;
      if (seenPacks.has(packName)) continue; // first root wins
      seenPacks.add(packName);

      const types = (raw as { artifactTypes?: unknown }).artifactTypes;
      if (!Array.isArray(types)) {
        errors.push({ pack: packName, message: 'artifact-type pack missing `artifactTypes[]`' });
        log.warn('rejected artifact-type pack', { pack: packName, message: 'missing artifactTypes[]' });
        continue;
      }
      for (const t of types) {
        try {
          const at = (t ?? {}) as Partial<ArtifactType>;
          if (typeof at.artifactTypeId !== 'string' || !at.artifactTypeId.trim()) throw new Error('`artifactTypeId` is required');
          if (at.schema == null || typeof at.schema !== 'object' || Array.isArray(at.schema)) throw new Error(`type \`${at.artifactTypeId}\`: \`schema\` must be a JSON Schema object`);
          // A pack MUST NOT silently override a HOST-native type — that could weaken a
          // built-in schema (and a stray pack symlinked into the shared pack dir from
          // another checkout is the parallel-worktree hazard). Preserve native; skip + warn.
          const prior = getArtifactType(at.artifactTypeId);
          if (prior && prior.registrationSource === 'host') {
            errors.push({ pack: packName, message: `type \`${at.artifactTypeId}\` collides with a host-native type — skipped` });
            log.warn('artifact-type pack tried to override a host-native type; skipped', { pack: packName, artifactTypeId: at.artifactTypeId });
            continue;
          }
          registerArtifactType({
            artifactTypeId: at.artifactTypeId,
            title: typeof at.title === 'string' && at.title.trim() ? at.title : at.artifactTypeId,
            schema: at.schema as Record<string, unknown>,
            export: Array.isArray(at.export) ? at.export.filter((e): e is string => typeof e === 'string') : [],
            registrationSource: 'pack',
          });
          registered.push(at.artifactTypeId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ pack: packName, message });
          log.warn('rejected artifact type from pack', { pack: packName, message });
        }
      }
    }
  }
  if (registered.length) log.info('artifact_type_packs_loaded', { count: registered.length, types: registered });
  return { registered, errors };
}
