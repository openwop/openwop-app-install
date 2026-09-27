// ADR 0181 Phase E / ADR 0182 Phase 4 — lifecycle for a desktop-managed LOCAL
// backend + subscription shim.
//
// The desktop can make the self-hosted subscription flow turnkey: launch a
// local `openwop-app-backend` (wired to the shim) and the shim itself, load the
// backend's origin, and tear both down on quit. The load-bearing rule (owns
// what it starts): if a process is ALREADY running we ADOPT it (never claim
// ownership, never kill it on exit); only processes we spawned are stopped.
//
// `spawnFn` and `isRunningFn` are injected so the ownership/lifecycle logic is
// unit-testable without real child processes. Never throws on stop. CommonJS.

'use strict';

class ManagedProcesses {
  /**
   * @param {object} deps
   * @param {(cmd: string, args: string[]) => {pid?: number, kill?: Function}} deps.spawnFn
   * @param {(key: string) => Promise<boolean>} deps.isRunningFn  already-up probe
   */
  constructor({ spawnFn, isRunningFn }) {
    this.spawnFn = spawnFn;
    this.isRunningFn = isRunningFn;
    /** key -> { child, owned } */
    this.owned = new Map();
  }

  /**
   * Ensure a process identified by `key` is running.
   * - already running (probe true) → ADOPT: record it as NOT owned, spawn nothing.
   * - not running → spawn it and record as owned.
   * Returns { started: boolean, adopted: boolean }.
   */
  async ensure(key, cmd, args = []) {
    if (this.owned.has(key)) return { started: false, adopted: false };
    const alreadyUp = await this.isRunningFn(key);
    if (alreadyUp) {
      this.owned.set(key, { child: null, owned: false });
      return { started: false, adopted: true };
    }
    const child = this.spawnFn(cmd, args);
    this.owned.set(key, { child, owned: true });
    return { started: true, adopted: false };
  }

  isOwned(key) {
    return this.owned.get(key)?.owned === true;
  }

  /** Stop ONLY processes we started; leave adopted ones running. */
  stop(key) {
    const entry = this.owned.get(key);
    if (!entry) return;
    if (entry.owned && entry.child && typeof entry.child.kill === 'function') {
      try { entry.child.kill('SIGTERM'); } catch { /* best effort */ }
    }
    this.owned.delete(key);
  }

  /** Stop everything we own (on app quit). Adopted processes are left alone. */
  stopAll() {
    for (const key of [...this.owned.keys()]) this.stop(key);
  }
}

module.exports = { ManagedProcesses };
