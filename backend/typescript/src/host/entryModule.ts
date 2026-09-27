/**
 * "Is this module the process entry point?" — the guard that decides whether
 * `index.ts` runs `main()`.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT A LINE IN `index.ts`. It was a line in
 * `index.ts`, and it was wrong for two years' worth of paths. It cannot be
 * tested there: importing `index.ts` from a test is exactly the case the guard
 * exists to prevent, so the only way to get a test around it is to move it.
 *
 * ── THE BUG THIS FIXES, AND WHY IT WAS INVISIBLE ──────────────────────────
 *
 * The old form was:
 *
 *     const isEntry = import.meta.url === `file://${process.argv[1]}`;
 *
 * `import.meta.url` is REALPATH-resolved — Node resolves module paths through
 * symlinks unless `--preserve-symlinks`. `process.argv[1]` is the path exactly
 * as the caller typed it. On macOS `/tmp` is a symlink to `/private/tmp`, so:
 *
 *     node /tmp/wt/backend/typescript/lib/index.js          -> 0 bytes, exit 0
 *     node /private/tmp/wt/backend/typescript/lib/index.js  -> boots, binds
 *
 * Same file, same env, only the spelling differs. And the failure mode is the
 * worst kind available: `main()` never runs, the event loop empties, and the
 * process exits **0 with no output at all**. A silent success. Nothing logs,
 * because logging happens inside `main()`.
 *
 * MEASURED CONSEQUENCE: `scripts/test-shutdown.sh` (the SHUTDOWN-1 merge gate)
 * spawns the built binary by absolute path and waits 60s for it to bind. From a
 * worktree under `/tmp` it could never bind, so the gate failed 4/4 at an idle
 * load average of 2.5 — while passing for anyone whose worktree lives under
 * `/Users/...`. That difference is what made it look like flakiness for days.
 * It also produced SPURIOUS PASSES: when a stray backend happened to hold the
 * port, the gate's `boot()` saw "port in use" and proceeded, so the gate was
 * reporting on somebody else's process.
 *
 * The second defect in the same line: hand-building `file://${path}` does not
 * percent-encode, but `import.meta.url` does. So a checkout path containing a
 * space or any non-ASCII character also silently disabled `main()`.
 *
 * Both are fixed by comparing what Node itself would produce: realpath the
 * argv path, then convert with `pathToFileURL` rather than string concatenation.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * True when `metaUrl` (a module's `import.meta.url`) identifies the same file
 * Node was launched with (`process.argv[1]`).
 *
 * `argv1` is optional because it genuinely can be absent — `node -e '...'` and
 * some embedders leave it undefined. Absent means "not launched as a script",
 * so the answer is false: failing CLOSED here means a server that does not
 * start, which is loud, rather than one that starts during a test run.
 */
export function isEntryModule(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  let resolved = argv1;
  try {
    // The entry may not exist as a real path in exotic launches; keep the
    // unresolved spelling rather than throwing, so the comparison still runs.
    resolved = realpathSync(argv1);
  } catch {
    /* not resolvable — fall through with the literal argv path */
  }
  return metaUrl === pathToFileURL(resolved).href;
}
