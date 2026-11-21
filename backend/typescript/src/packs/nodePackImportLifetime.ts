/**
 * Process-lifetime ownership of executable node-pack import paths.
 * Node's ESM cache cannot be invalidated. A failed/pending import owns its path
 * too: replacement requires a fresh process, not a new metadata label.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { packContentDigest } from './packContentDigest.js';

export class PackRestartRequiredError extends Error {
  constructor() {
    super('pack_restart_required: executable pack code is already bound in this host process; configure the desired version for startup and restart this host before replacing or reloading changed bytes.');
    this.name = 'PackRestartRequiredError';
  }
}
interface ImportClaim { readonly path: string; readonly real: string; readonly digest: string }
interface ImportedTree { readonly digest: string; readonly real: string }
const importedTrees = new Map<string, ImportedTree>();

function roots(path: string): { path: string; real: string } {
  const absolute = resolve(path);
  try {
    return { path: absolute, real: existsSync(absolute) ? realpathSync(absolute) : absolute };
  } catch {
    throw new PackRestartRequiredError();
  }
}

/** Called immediately before the normal installer archives/removes/copies a head.
 * No await is permitted between this check and the synchronous replacement.
 * Same-version no-op installs return earlier and never reach this guard.
 */
export function assertNodePackReplaceable(path: string): void {
  const keys = roots(path);
  if (importedTrees.has(keys.path) || importedTrees.has(keys.real)) throw new PackRestartRequiredError();
}

/** After trust/member verification, BEFORE the first asynchronous import.
 * Retain the binding on every outcome: native ESM also caches rejected imports.
 */
export function claimNodePackImport(path: string, manifestBytes: Buffer): ImportClaim {
  try {
    const keys = roots(path);
    if (!readFileSync(join(keys.path, 'pack.json')).equals(manifestBytes)) throw new PackRestartRequiredError();
    const digest = packContentDigest(keys.path);
    for (const key of [keys.path, keys.real]) {
      const previous = importedTrees.get(key);
      if (previous !== undefined && (previous.digest !== digest || previous.real !== keys.real)) throw new PackRestartRequiredError();
    }
    const binding = Object.freeze({ digest, real: keys.real });
    for (const key of [keys.path, keys.real]) importedTrees.set(key, binding);
    return Object.freeze({ ...keys, digest });
  } catch {
    throw new PackRestartRequiredError();
  }
}

/** A normal in-process installer is excluded by the claim above. This also
 * refuses an observed external/development mutation before registering labels.
 * It is not an atomic filesystem snapshot or a promise against external ABA.
 */
export function assertNodePackImportUnchanged(claim: ImportClaim): void {
  try {
    const now = roots(claim.path);
    if (now.real !== claim.real || packContentDigest(claim.path) !== claim.digest) throw new PackRestartRequiredError();
  } catch {
    throw new PackRestartRequiredError();
  }
}
