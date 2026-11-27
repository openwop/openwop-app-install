/**
 * Repo-path resolution that survives both the source-tree layout AND
 * the esbuild-bundled `lib/index.js` layout.
 *
 * The workflow-engine sample is built in two ways:
 *   - **Source tree** (typecheck, IDE, `tsc --noEmit`): files live at
 *     `backend/typescript/src/host/<file>.ts` — six
 *     levels deep from repo root.
 *   - **Bundled tree** (production `npm start`, the Cloud Run image,
 *     and the standalone host conformance runs): every backend module
 *     is collapsed into `backend/typescript/lib/index.js`
 *     — only four levels deep.
 *
 * Modules that read sibling-repo files (e.g., `<repo>/schemas/v2/*`) via
 * `resolve(__dirname, '..' × 6, 'schemas')` worked under typecheck but
 * crashed under the bundled tree because `..` × 6 from `lib/` overshoots
 * two levels past the repo root. The bug surfaced 2026-05-23 — see
 * commit `d09d99c` for the original diagnosis. This module exists so
 * every subsequent path-resolution site can share one robust helper
 * instead of duplicating the buggy pattern.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Locate a sibling directory of one of the parents of `fromDir` by name,
 * verifying its identity via a sentinel file inside it. Walks parent
 * directories until `<parent>/<dirName>/<sentinelRelPath>` exists.
 *
 * @param fromDir Starting directory — typically `dirname(fileURLToPath(import.meta.url))`.
 * @param dirName Name of the directory to look for as a sibling of a parent
 *   (e.g., `'schemas'` for `<repo>/schemas`; `'conformance-fixtures'` for
 *   `<workflow-engine>/conformance-fixtures`).
 * @param sentinelRelPath A path INSIDE `dirName` that must exist for the
 *   match to be accepted. Makes the walk robust against false positives —
 *   a random `schemas/` directory somewhere in the parent chain won't
 *   match unless it contains the actual file the caller cares about.
 *   Examples:
 *     - `'v2/ids.schema.json'` for the vendored v2 schema tree (schemas dir)
 *     - `'prompt-templates/conformance-prompt-writer-system.json'` for the
 *       prompt store (conformance-fixtures dir)
 * @returns Absolute path to the matched `<parent>/<dirName>` directory.
 * @throws Error when the walk terminates at the filesystem root without
 *   finding a match. Caller is expected to fail loudly at module-load
 *   (the original lazy ENOENT-at-first-request pattern is what concealed
 *   the bug for so long).
 */
export function locateRepoDir(
  fromDir: string,
  dirName: string,
  sentinelRelPath: string,
): string {
  let cur = fromDir;
  // The walk naturally terminates at the filesystem root via the
  // `parent === cur` check; no explicit depth cap needed.
  for (;;) {
    const candidate = resolve(cur, dirName);
    if (existsSync(join(candidate, sentinelRelPath))) return candidate;
    const parent = dirname(cur);
    if (parent === cur) {
      throw new Error(
        `locateRepoDir: walked from "${fromDir}" to filesystem root without finding ` +
          `a sibling "${dirName}/" directory containing "${sentinelRelPath}". ` +
          `Verify the workflow-engine is running inside the openwop repo tree.`,
      );
    }
    cur = parent;
  }
}

/**
 * Locate the vendored v2 schema tree, `<repo>/schemas/v2/`, and return THAT
 * directory (not its parent).
 *
 * RFC 0266 (v2 is self-contained): this host reads no file from the frozen flat
 * v1 tree `schemas/*.schema.json`, and that tree is no longer vendored. The old
 * `locateRepoSchemasDir(fromDir, '<flat>.schema.json')` form is gone on purpose:
 * most of its ~25 callers passed a FLAT sentinel only to find the directory and
 * then read `v2/…` under it, so deleting the flat tree would have broken every
 * one of them at module load. The sentinel now lives inside `v2/`, and a caller
 * cannot spell a flat read through this helper.
 *
 * `scripts/check-v1-reliance.mjs` `flatSchemaReads` holds the line at zero.
 *
 * @param sentinelFile A file inside `schemas/v2/` that must exist for the match
 *   to be accepted. Defaults to `ids.schema.json`, which every v2 id-bearing
 *   schema `$ref`s, so a v2 tree without it is unusable anyway.
 */
export function locateRepoSchemasV2Dir(fromDir: string, sentinelFile = 'ids.schema.json'): string {
  return join(locateRepoDir(fromDir, 'schemas', join('v2', sentinelFile)), 'v2');
}

/** The repository root (or `/app` in the image): the parent of `schemas/`. For
 *  loaders whose default pack roots sit beside the vendored schemas. */
export function locateRepoRootFromSchemas(fromDir: string): string {
  return dirname(dirname(locateRepoSchemasV2Dir(fromDir)));
}
