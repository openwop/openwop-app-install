// ADR 0785 P2 — PTY sessions on the user's machine.
//
// One session = one `claude` process in a pseudo-terminal, viewed in the web
// app's terminal tab. Carries the prior art's hard-won details (ADR 0785 D4):
//   - GENERATIONS: every spawn gets a number; output, exit and input carry it,
//     so a late exit from a killed process can never tear down its replacement.
//   - A REPLAY BUFFER per session (512 KiB, FIFO of chunks): a viewer that
//     (re)attaches first receives the buffer, then live bytes. It lives HERE, on
//     the source of truth, so a relay restart loses nothing.
//   - STOP IS A PROCESS-GROUP KILL: SIGHUP first, then after a grace period
//     SIGKILL to the whole group. Claude Code ignores SIGHUP, and orphaned MCP
//     children would otherwise keep running (prior-art lesson 4).
//
// The PTY implementation is injected so tests run without a real terminal.

import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const REPLAY_CAPACITY_BYTES = 512 * 1024;
export const STOP_GRACE_MS = 3000;

/**
 * node-pty's macOS prebuilds ship `spawn-helper` WITHOUT its execute bit, so
 * every spawn fails with "posix_spawnp failed" (MEASURED 2026-09-30, node-pty
 * 1.1.0, darwin-arm64). Repair it once at startup rather than asking users to
 * chmod a file inside node_modules.
 */
export function ensureSpawnHelperExecutable(requireFn = createRequire(import.meta.url)) {
  let root;
  try { root = dirname(requireFn.resolve('node-pty/package.json')); } catch { return false; }
  let fixed = false;
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    const helper = join(root, 'prebuilds', arch, 'spawn-helper');
    if (!existsSync(helper)) continue;
    if ((statSync(helper).mode & 0o111) === 0) { chmodSync(helper, 0o755); fixed = true; }
  }
  return fixed;
}

/** The real PTY factory (lazy, so tests and `pair` never load the native module). */
export function nodePtyFactory() {
  const require = createRequire(import.meta.url);
  ensureSpawnHelperExecutable(require);
  const pty = require('node-pty');
  return (command, args, opts) => pty.spawn(command, args, opts);
}

class ReplayBuffer {
  constructor(capacity) { this.capacity = capacity; this.chunks = []; this.bytes = 0; }
  push(chunk) {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.capacity && this.chunks.length > 1) this.bytes -= this.chunks.shift().length;
  }
  snapshot() { return Buffer.concat(this.chunks); }
}

export class PtySessions {
  /**
   * @param {{
   *   ptyFactory: (command: string, args: string[], opts: object) => any,
   *   onOutput?: (sessionId: string, generation: number, chunk: Buffer) => void,
   *   onExit?: (sessionId: string, generation: number, exitCode: number | null, requested: boolean) => void,
   *   killGroup?: (pid: number, signal: string) => void,
   *   setTimer?: (fn: () => void, ms: number) => unknown,
   *   replayCapacity?: number,
   * }} opts
   */
  constructor(opts) {
    this.ptyFactory = opts.ptyFactory;
    this.onOutput = opts.onOutput ?? (() => {});
    this.onExit = opts.onExit ?? (() => {});
    this.killGroup = opts.killGroup ?? defaultKillGroup;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.replayCapacity = opts.replayCapacity ?? REPLAY_CAPACITY_BYTES;
    this.nextGeneration = 1;
    /** @type {Map<string, {generation: number, pty: any, replay: ReplayBuffer, stopRequested: boolean, exited: boolean}>} */
    this.sessions = new Map();
  }

  /** Spawn (or replace) a session's process. Returns its generation. */
  start(sessionId, { command, args = [], cwd, env, cols = 120, rows = 32 }) {
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.exited) this.stop(sessionId);
    const generation = this.nextGeneration++;
    const pty = this.ptyFactory(command, args, {
      name: 'xterm-256color', cols, rows, cwd,
      env: { ...env, TERM: 'xterm-256color', LANG: env?.LANG ?? 'en_US.UTF-8' },
    });
    const state = { generation, pty, replay: new ReplayBuffer(this.replayCapacity), stopRequested: false, exited: false };
    this.sessions.set(sessionId, state);
    pty.onData((data) => {
      const current = this.sessions.get(sessionId);
      if (!current || current.generation !== generation) return; // a stale process's late output
      const chunk = Buffer.from(data, 'utf8');
      current.replay.push(chunk);
      this.onOutput(sessionId, generation, chunk);
    });
    pty.onExit(({ exitCode }) => {
      const current = this.sessions.get(sessionId);
      if (!current || current.generation !== generation || current.exited) return; // never tear down a replacement
      current.exited = true;
      this.onExit(sessionId, generation, exitCode ?? null, current.stopRequested);
    });
    return generation;
  }

  /** Keystrokes from a viewer. Ignored unless they target the live generation. */
  write(sessionId, data, generation) {
    const s = this.sessions.get(sessionId);
    if (!s || s.exited || (generation !== undefined && generation !== s.generation)) return false;
    s.pty.write(data);
    return true;
  }

  resize(sessionId, cols, rows) {
    const s = this.sessions.get(sessionId);
    if (!s || s.exited) return false;
    const c = clampInt(cols, 10, 1000); const r = clampInt(rows, 5, 500);
    if (c === null || r === null) return false;
    s.pty.resize(c, r);
    return true;
  }

  /** What a (re)attaching viewer receives before live output. */
  replay(sessionId) {
    return this.sessions.get(sessionId)?.replay.snapshot() ?? Buffer.alloc(0);
  }

  generationOf(sessionId) { return this.sessions.get(sessionId)?.generation ?? null; }

  /** SIGHUP, then after the grace period SIGKILL the whole process group. */
  stop(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || s.exited) return false;
    s.stopRequested = true;
    try { s.pty.kill('SIGHUP'); } catch { /* already gone */ }
    const { pid, generation } = { pid: s.pty.pid, generation: s.generation };
    this.setTimer(() => {
      const current = this.sessions.get(sessionId);
      if (current && current.generation === generation && !current.exited) this.killGroup(pid, 'SIGKILL');
    }, STOP_GRACE_MS);
    return true;
  }

  stopAll() { for (const id of this.sessions.keys()) this.stop(id); }

  forget(sessionId) { this.sessions.delete(sessionId); }
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** node-pty makes the child a session leader, so -pid addresses its whole group. */
function defaultKillGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch { /* group gone */ }
  try { process.kill(pid, signal); } catch { /* process gone */ }
}
