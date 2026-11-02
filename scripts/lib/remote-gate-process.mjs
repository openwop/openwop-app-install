/** ADR 0863 D9: process identity for the installed remote-gate supervisor.
 *
 * A process identity is {pid, startedAt, uid, executable}; a PID alone never is.
 * The table interface is per platform:
 *   list()               -> (async) every visible process {pid, ppid, pgid, uid, startedAt, executable}
 *                           or {pid, unreadable: true}; THROWS when the scan itself fails.
 *   members(rows, h)     -> the pids that belong to the gate whose holder is pid `h`.
 *   holder               -> {file, args(command, args)}: the process that leads the
 *                           gate's group, pins it, and reports the gate's exit on fd 3.
 *   signal(identity, s)  -> (maybe async) deliver to ONE process (never a group);
 *                           false when that identity is already gone.
 * macOS: membership is the process group; R1, R2 and R3 remain.
 * Linux (2026-10-31, worker host = GCP VM): the holder is a child subreaper, so
 * every descendant stays under it even after setsid/setpgid (closes R2 and the
 * reparent loss); identity is boot id + /proc starttime in clock ticks (closes R3);
 * signals go through a pidfd opened BEFORE the identity re-check (closes R1).
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';

// `%c` in the C locale: "Wed Oct 28 19:35:24 2026", day space-padded.
const LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s(.*)$/;

/** Parse one `ps -o pid=,ppid=,pgid=,uid=,lstart=,comm=` line. A row with a pid but
 * unparseable identity is returned as unreadable rather than dropped: unreadable
 * is UNKNOWN, never "a different process". */
export function parseMacosPsLine(line) {
  const match = LINE.exec(line);
  if (match) {
    const [, pid, ppid, pgid, uid, lstart, comm] = match;
    const executable = comm.trim();
    const startedAt = lstart.replace(/\s+/g, ' ');
    if (executable) return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), uid: Number(uid), startedAt, executable };
  }
  const pid = /^\s*(\d+)\b/.exec(line);
  return pid ? { pid: Number(pid[1]), unreadable: true } : null;
}

function guardedSignal(pid, signal) {
  // Never a group, never ourselves, never init/launchd.
  assert(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid, 'single owned pid required');
  try { process.kill(pid, signal); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

// $1.. is the gate argv, never interpolated. The subshell restores default
// dispositions (they were not ignored on entry) so the gate itself is signalable.
const SH_HOLDER = [
  "trap '' TERM INT HUP",
  '( trap - TERM INT HUP; exec "$@" ) 3>&-',
  'printf \'%s\\n\' "$?" >&3',
  'exec 3>&-',
  'exec /bin/sleep 2147483647',
].join('\n');

export function macosProcessTable({ ps = '/bin/ps' } = {}) {
  return Object.freeze({
    platform: 'darwin',
    holder: { file: '/bin/sh', args: (command, args) => ['-c', SH_HOLDER, 'remote-gate-holder', command, ...args] },
    members: (rows, holderPid) => new Set(rows.filter(r => !r.unreadable && r.pgid === holderPid && r.pid !== holderPid).map(r => r.pid)),
    // Async on purpose: spawnSync runs a private libuv loop that swallows the
    // SIGCHLD of our async holder, which then stays an unreaped zombie (MEASURED).
    async list() {
      const stdout = await new Promise((resolve, reject) => execFile(ps,
        ['-A', '-o', 'pid=,ppid=,pgid=,uid=,lstart=,comm='], {
          encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
          // Forced, never inherited: lstart is printed in the local zone and locale.
          env: { TZ: 'UTC', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
        }, (error, out) => (error ? reject(new Error(`process scan failed: ${error.code ?? error.signal}`)) : resolve(out))));
      const rows = stdout.split('\n').filter(Boolean).map(parseMacosPsLine);
      assert(rows.length > 0 && rows.every(Boolean), 'process scan unparseable');
      return rows;
    },
    signal: (identity, signal) => guardedSignal(identity.pid, signal),
  });
}

/** Parse /proc/<pid>/stat. `comm` may hold spaces and parentheses, so split at
 * the LAST ')'. Fields after it: state ppid pgrp session ... starttime (#22). */
export function parseLinuxStat(text, bootId) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const rest = text.slice(close + 2).trim().split(/\s+/);
  const [state, ppid, pgid] = [rest[0], Number(rest[1]), Number(rest[2])];
  const starttime = rest[19];
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || !/^\d+$/.test(starttime ?? '')) return null;
  return { pid, ppid, pgid, state, startedAt: `${bootId}/${starttime}`, executable: text.slice(open + 1, close) };
}

// Python because Node has neither prctl nor pidfd. Both are fixed scripts; argv
// is data. The holder sets PR_SET_CHILD_SUBREAPER (36), ignores TERM/INT/HUP,
// runs the gate with default dispositions, writes its exit (128+signal when
// killed) to fd 3, then keeps reaping orphans until it is killed itself.
const PY_HOLDER = `
import ctypes, os, signal, sys
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0: sys.exit(71)
for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(s, signal.SIG_IGN)
gate = os.fork()
if gate == 0:
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(s, signal.SIG_DFL)
    os.close(3)
    try: os.execvp(sys.argv[1], sys.argv[1:])
    finally: os._exit(127)
while True:
    try: pid, status = os.waitpid(-1, 0)
    except ChildProcessError: signal.pause(); continue
    if pid == gate:
        code = os.waitstatus_to_exitcode(status)
        os.write(3, b'%d\\n' % (128 - code if code < 0 else code)); os.close(3)
`;
// Exit 0 = signalled; 3 = gone or a different process now holds the pid.
const PY_PIDFD_SIGNAL = `
import os, signal, sys
pid, want, sig = int(sys.argv[1]), sys.argv[2], getattr(signal, sys.argv[3])
try: fd = os.pidfd_open(pid)
except ProcessLookupError: sys.exit(3)
try:
    with open('/proc/sys/kernel/random/boot_id') as f: boot = f.read().strip()
    with open('/proc/%d/stat' % pid) as f: text = f.read()
except FileNotFoundError: sys.exit(3)
rest = text[text.rindex(')') + 2:].split()
if rest[0] == 'Z' or '%s/%s' % (boot, rest[19]) != want: sys.exit(3)
try: signal.pidfd_send_signal(fd, sig)
except ProcessLookupError: sys.exit(3)
`;

export function linuxProcessTable({ proc = '/proc', python = '/usr/bin/python3' } = {}) {
  return Object.freeze({
    platform: 'linux',
    holder: { file: python, args: (command, args) => ['-I', '-c', PY_HOLDER, command, ...args] },
    members(rows, holderPid) {
      const children = new Map();
      for (const r of rows) if (!r.unreadable) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r.pid]);
      // The process group as well: after a holder is lost, its orphans keep the
      // group id but no longer descend from it, and must still count.
      const out = new Set();
      const queue = [...(children.get(holderPid) ?? []),
        ...rows.filter(r => !r.unreadable && r.pgid === holderPid && r.pid !== holderPid).map(r => r.pid)];
      while (queue.length) {
        const pid = queue.shift();
        if (out.has(pid)) continue;
        out.add(pid);
        queue.push(...(children.get(pid) ?? []));
      }
      return out;
    },
    async list() {
      const bootId = (await readFile(`${proc}/sys/kernel/random/boot_id`, 'utf8')).trim();
      assert(/^[0-9a-f-]{36}$/.test(bootId), 'boot id unreadable');
      const rows = [];
      for (const name of await readdir(proc)) {
        if (!/^\d+$/.test(name)) continue;
        let text; let owner;
        try {
          [text, owner] = await Promise.all([readFile(`${proc}/${name}/stat`, 'utf8'), stat(`${proc}/${name}`)]);
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; // exited during the scan
          rows.push({ pid: Number(name), unreadable: true });
          continue;
        }
        const row = parseLinuxStat(text, bootId);
        if (!row) { rows.push({ pid: Number(name), unreadable: true }); continue; }
        if (row.state === 'Z') continue; // dead; its pid cannot be reused until reaped
        const { state, ...identity } = row;
        rows.push({ ...identity, uid: owner.uid });
      }
      assert(rows.length > 0, 'process scan empty');
      return rows;
    },
    async signal(identity, signal) {
      assert(Number.isSafeInteger(identity.pid) && identity.pid > 1 && identity.pid !== process.pid, 'single owned pid required');
      assert(/^SIG[A-Z]+$/.test(signal), 'signal name');
      return new Promise((resolve, reject) => execFile(python, ['-I', '-c', PY_PIDFD_SIGNAL, String(identity.pid), identity.startedAt, signal],
        { timeout: 10_000, env: { PATH: '/usr/bin:/bin' } }, error => {
          if (!error) return resolve(true);
          if (error.code === 3) return resolve(false);
          reject(new Error(`pidfd signal failed: ${error.code ?? error.signal}`));
        }));
    },
  });
}

export function processTableFor(platform = process.platform) {
  if (platform === 'darwin') return macosProcessTable();
  if (platform === 'linux') return linuxProcessTable();
  throw new Error(`unsupported worker platform: ${platform}`);
}

/** 'same' only when every field is readable and equal; 'unknown' when either side
 * is unreadable; 'different' only on positive evidence (a readable mismatch). */
export function compareIdentity(recorded, observed) {
  if (!observed) return 'gone';
  if (recorded.unreadable || observed.unreadable) return 'unknown';
  return recorded.pid === observed.pid && recorded.startedAt === observed.startedAt
    && recorded.uid === observed.uid && recorded.executable === observed.executable ? 'same' : 'different';
}

export const identityKey = p => `${p.pid}\t${p.uid}\t${p.startedAt}\t${p.executable}`;
