/**
 * "Was this script launched directly?" — for the root `scripts/*.mjs`.
 *
 * The ESM sibling of `backend/typescript/src/host/entryModule.ts`, which fixed
 * this same defect in the server (#3070). Two copies exist deliberately: the
 * backend one is TypeScript compiled into the server bundle, these are plain
 * `.mjs` run by `node` from the repo root, and there is no build step joining
 * them. `scripts/check-entry-guard.mjs` is what keeps them from drifting — it
 * refuses any hand-rolled variant of this comparison anywhere in the tree.
 *
 * ── WHY THE OBVIOUS ONE-LINER IS WRONG ────────────────────────────────────
 *
 *     import.meta.url === `file://${process.argv[1]}`          // BROKEN
 *     fileURLToPath(import.meta.url) === process.argv[1]       // ALSO BROKEN
 *
 * `import.meta.url` is REALPATH-resolved — Node resolves module paths through
 * symlinks unless `--preserve-symlinks`. `process.argv[1]` is the path exactly
 * as the caller typed it. So both forms are false whenever the script is invoked
 * through a symlinked absolute path, and the block they guard silently does not
 * run. The first form has a second defect: `import.meta.url` percent-encodes and
 * string concatenation does not, so a path containing a space also fails.
 *
 * MEASURED, on this repo, before the fix:
 *
 *     node /Users/…/scripts/gen-distribution.mjs --check
 *       ✓ no-sales: excludes BE 60 / FE 44 …            rc=0
 *     node /tmp/link-to-repo/scripts/gen-distribution.mjs --check
 *       (no output whatsoever)                          rc=0
 *
 * That second line is a VALIDATION GATE PASSING WITHOUT VALIDATING ANYTHING —
 * `ci:distribution` runs exactly that command — and until `scripts/ci.sh` began
 * invoking `--check` directly, nothing ran `ci:distribution`. Silent success is this repo's
 * dominant defect family, and a guard that cannot fire is not a guard.
 *
 * These normally work only by luck: they are invoked with RELATIVE paths, and
 * `process.cwd()` is realpath-resolved on macOS, so the comparison happens to
 * match. An absolute symlinked invocation is all it takes.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * True when `metaUrl` (the caller's `import.meta.url`) is the file Node was
 * launched with (`process.argv[1]`).
 *
 * Usage — pass `import.meta.url` explicitly; it cannot be read from here:
 *
 *     if (isEntryModule(import.meta.url)) { main(); }
 *
 * Absent `argv[1]` (`node -e`, some embedders) answers false: failing CLOSED
 * means the script's side effects do not run when it was merely imported.
 */
export function isEntryModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  let resolved = argv1;
  try {
    resolved = realpathSync(argv1);
  } catch {
    /* not resolvable on disk — compare the literal spelling rather than throw */
  }
  return metaUrl === pathToFileURL(resolved).href;
}
