/**
 * The per-worker pack-tree sweep (test/setup/sweepPackDirs.ts). Its failure mode
 * reached a merge train: it deleted a tree a live worker had just inherited
 * through a recycled pid, and threw ENOTEMPTY (the 2026-10-08 merge train, in
 * `crm-gmail-sync-pin`; see the src docblock). Each rule is pinned on a private
 * root, never the shared $TMPDIR one.
 *
 * The `pid <= 0` guard is witnessed by a NEGATIVE name (`w-<deadPid>`), not by
 * `w0`: `process.kill(0, 0)` signals our own process group, succeeds, and reads
 * as alive, so `w0` survives with the guard deleted (probe 8fw3g3-swp-pid0 was
 * vacuous on `w0` alone). `kill(-N, 0)` targets process group N; a just-exited
 * child was never a group leader, so that group does not exist (ESRCH) and only
 * `pid <= 0` keeps the tree.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_IDLE_MS, sweepDeadPackDirs } from './setup/sweepPackDirs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'owp-sweep-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A pid that has certainly exited: spawn a process and wait for it. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}

function tree(name: string, ageMs: number): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), '{}');
  const t = new Date(Date.now() - ageMs);
  utimesSync(dir, t, t);
  return dir;
}

describe('sweepDeadPackDirs', () => {
  it('removes a dead worker\'s tree once it has been idle past the window', () => {
    const name = `w${deadPid()}`;
    tree(name, MIN_IDLE_MS + 60_000);
    expect(sweepDeadPackDirs(Date.now(), root)).toEqual([name]);
    expect(existsSync(join(root, name))).toBe(false);
  });

  it('keeps a dead pid\'s tree that was touched recently: a recycled pid may be filling it', () => {
    const name = `w${deadPid()}`;
    tree(name, 5_000);
    expect(sweepDeadPackDirs(Date.now(), root)).toEqual([]);
    expect(existsSync(join(root, name))).toBe(true);
  });

  it('keeps a live pid\'s tree however old it is, including its own', () => {
    tree(`w${process.pid}`, MIN_IDLE_MS * 10);
    tree(`w${process.ppid}`, MIN_IDLE_MS * 10);
    expect(sweepDeadPackDirs(Date.now(), root)).toEqual([]);
  });

  it('ignores names that are not w<pid>, and never throws on a missing root', () => {
    tree('not-a-worker', MIN_IDLE_MS * 10);
    tree('w0', MIN_IDLE_MS * 10);
    tree(`w-${deadPid()}`, MIN_IDLE_MS * 10);
    tree('wabc', MIN_IDLE_MS * 10);
    expect(sweepDeadPackDirs(Date.now(), root)).toEqual([]);
    expect(() => sweepDeadPackDirs(Date.now(), join(root, 'nope'))).not.toThrow();
  });
});
