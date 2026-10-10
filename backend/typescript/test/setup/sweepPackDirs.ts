/**
 * Removes per-worker pack trees (see isolatePackDir.ts) whose worker is gone.
 *
 * Each tree is ~200 files and every run spawns fresh pids, so leaving them
 * behind piled up ~19M files in $TMPDIR in two weeks — enough FSEvents churn to
 * stall Spotlight's indexer for the whole volume. Vitest kills fork workers
 * without emitting `exit` (and still has them alive when globalSetup teardown
 * runs), so a worker cannot clean up after itself. Instead each worker sweeps
 * at start, which bounds the leftovers to recent runs' trees.
 *
 * A tree is removed only when BOTH hold:
 *   - its pid is dead (`process.kill(pid, 0)` → `ESRCH`); a live pid, ours or a
 *     concurrent run's, is left alone;
 *   - it has not been touched for {@link MIN_IDLE_MS}.
 *
 * The age gate is what makes the pid test safe. Pids are RECYCLED: between
 * "w7109's pid is dead" and the delete, a new worker can be born as 7109 and
 * start filling `w7109`. Deleting then pulls packs out from under a live worker
 * and fails the sweep with `ENOTEMPTY` (MEASURED: the 2026-10-08 merge train went
 * red on exactly this, in `crm-gmail-sync-pin`). A tree the new worker is
 * populating is fresh, so it is skipped.
 *
 * The sweep NEVER throws. It is housekeeping that runs inside test setup, and a
 * race with another sweeper (both deleting one dead tree) must not fail the file
 * that happened to start second.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, rmSync, statSync } from 'node:fs';

export const PACK_DIRS_ROOT = join(tmpdir(), 'owp-test-packs');

/** A tree untouched for less than this is never removed, whatever its pid says. */
export const MIN_IDLE_MS = 30 * 60 * 1000;

function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM means the pid exists under another user: alive, not ours to judge.
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Returns the names it removed, for the witness. */
export function sweepDeadPackDirs(now: number = Date.now(), root: string = PACK_DIRS_ROOT): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const pid = Number(name.slice(1));
    if (!name.startsWith('w') || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (!pidIsDead(pid)) continue;
    const path = join(root, name);
    try {
      if (now - statSync(path).mtimeMs < MIN_IDLE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Gone already (another sweeper), or being written (pid reuse inside the
      // window): not ours. Skip it; the next sweep will see it settled.
    }
  }
  return removed;
}
