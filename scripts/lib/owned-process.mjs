#!/usr/bin/env node
/** ADR 0863 D3: one owned process group, including npm/sh/build grandchildren. */
import { spawn } from 'node:child_process';

const [cwd, executable, ...args] = process.argv.slice(2);
if (!cwd || !executable || process.platform === 'win32') process.exit(2);
const child = spawn(executable, args, { cwd, env: process.env, stdio: 'inherit', detached: true });
let stopped = false;
let exitCode = 1;
function signalGroup(signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
function finish(code) {
  if (stopped) return;
  stopped = true;
  exitCode = code;
  signalGroup('SIGTERM');
  // Keep the supervisor alive through escalation, including when the leader
  // exits first and its TERM-resistant grandchildren remain in our group.
  setTimeout(() => { signalGroup('SIGKILL'); process.exit(exitCode); }, 500);
}
process.on('SIGTERM', () => { exitCode = 143; finish(143); });
process.on('SIGINT', () => { exitCode = 130; finish(130); });
child.on('error', (error) => { console.error(`owned process could not start: ${error.code}`); finish(1); });
child.on('exit', (code, signal) => finish(code ?? (signal === 'SIGINT' ? 130 : 143)));
