/**
 * ADR 0146 Phase 4a — in-process code-exec sandbox: CPython compiled to `wasi-preview1`, run under
 * Node's built-in `node:wasi` in a `node:worker_threads` Worker. Backs `ctx.runSandboxedCode` and is
 * ON BY DEFAULT whenever the vendored asset is present (no external endpoint configured); an external
 * Code-API endpoint always wins, and `OPENWOP_CODE_EXEC_RUNTIME=off` opts out. Replaces the REVERTED
 * Pyodide attempt (#902/#904).
 *
 * WHY THIS IS SOUND (and Pyodide was not): a raw WASI guest has NO `js` FFI — there is no bridge
 * from the sandboxed Python into the Node global scope. `node:wasi` grants the guest ONLY the WASI
 * syscalls + preopens we pass, and we pass: `env:{}` (no host env), a FRESH per-exec empty dir
 * preopened as `/tmp` (no host fs reachable — and WASI's capability model denies `../` traversal +
 * symlink escape OUT of the preopen, verified), and no sockets (wasi-preview1 has none). Verified by
 * the adversarial escape suite (`test/wasi-sandbox.test.ts`): `import js` → ModuleNotFoundError,
 * fs/env/socket/subprocess/ctypes + traversal/symlink all denied — the escape *class* is absent.
 *
 * ENFORCEMENT:
 *  - wall-clock: the HOST owns the worker; on timeout it `worker.terminate()`s — kills even a tight
 *    `while True: pass` (verified). `wasi.start()` blocks its thread, so it MUST run in a worker.
 *  - memory: CORRECTED (ADR 0995 D3) — this said "BEST-EFFORT … V8 cannot cap its growth", and
 *    the binary does declare no maximum. But the limit is in the module's own memory section, so
 *    the host rewrites it before compiling (`capWasmMemory`, `OPENWOP_CODE_EXEC_WASI_MEM_MB`,
 *    default 256): `memory.grow` past it fails inside the guest and CPython raises MemoryError.
 *    The WASI rung also has its own concurrency cap (default 2) so the AGGREGATE fits an instance.
 *  - disk: guest /tmp and the captured output live in host tmpfs (RAM on Cloud Run gen2). A host
 *    watchdog measures them every 100 ms and kills the run past `OPENWOP_CODE_EXEC_MAX_SCRATCH_MB`
 *    (default 64) or 10 000 entries. It can overshoot by one interval's writes; stated, not hidden.
 *  - capture plumbing (stdout/stderr/stdin files) lives OUTSIDE the preopen, so the guest can neither
 *    read its own stdin file nor forge/truncate the captured output.
 *  - a FRESH worker + scratch dir per execution ⇒ no state/leak between runs; the HOST removes the
 *    scratch on every exit path, a wall-clock kill included (ADR 0995 D4).
 *
 * Python-only. REPLAY-NEUTRAL: runs only on live execution; the result is recorded as a
 * `code.execution-result` artifact (ADR 0114) and replay/`:fork` read that verbatim.
 * `node:wasi` is flagged experimental in Node — pin Node + keep the escape suite a CI gate.
 */
import { Worker } from 'node:worker_threads';
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { readdir, lstat, readlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createLogger } from '../observability/logger.js';
import { locateRepoDir } from './_repoPath.js';
import type { SandboxExecRequest, SandboxExecResult } from '../executor/types.js';
import { classifySandboxError, recordSandboxExecution } from '../observability/metricSeams.js';

// `WebAssembly` is a Node runtime global but not in this project's ES2022 lib (no DOM lib, by
// design). Declare only the method we use; the compiled module is opaque here — produced by
// `WebAssembly.compile` and passed by structured-clone to the worker, which instantiates it.
declare const WebAssembly: { compile(bytes: Uint8Array): Promise<object> };

const log = createLogger('host.wasiSandbox');

const MAX_CODE_BYTES = 200_000;
const MAX_STDIN_BYTES = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000; // cap stdout/stderr READ into host memory (a huge print must not OOM the host)

const WASI_LANGUAGES = ['python'];
export function wasiAllowedLanguages(): string[] { return [...WASI_LANGUAGES]; }

/** Resolve the vendored CPython-WASI binary (synced by `scripts/sync-pythonwasm.sh`). An operator
 *  override wins; else locate the `vendor/` dir via the layout-independent walk — this MUST survive
 *  both the src tree AND the esbuild-bundled `lib/index.js` (a raw `import.meta.url`-relative path
 *  resolves to `/vendor` in the bundle, not `<app>/vendor`; `locateRepoDir` keys off the tracked
 *  `.gitkeep` sentinel). Returns '' when the dir can't be located ⇒ `wasiRuntimeEnabled()` honest-off. */
export function wasmPath(): string {
  const override = process.env.OPENWOP_CODE_EXEC_WASM_PATH?.trim();
  if (override) return override;
  try {
    return join(locateRepoDir(dirname(fileURLToPath(import.meta.url)), 'vendor', '.gitkeep'), 'python-3.12.0.wasm');
  } catch {
    return '';
  }
}

/** ON BY DEFAULT (ADR 0146 OQ-1 reversed 2026-06-26): the in-process WASI runtime is active
 *  whenever its vendored asset is present — code-exec works out-of-box, no opt-in env. An operator
 *  can explicitly opt OUT with `OPENWOP_CODE_EXEC_RUNTIME=off` (or `none`/`disabled`); an external
 *  endpoint always wins (`resolveSandboxExecutor`). The asset guard keeps a host that never ran
 *  `sync-pythonwasm.sh` honest-off (no false advertisement). Each run is still HITL-gated + budgeted.
 *
 *  CORRECTED (ADR 0995 D8) — in PRODUCTION the default above meant nobody chose. `.gcloudignore`
 *  ships the asset when it exists, `npm run ci` syncs it and `deploy.sh` does not, so a deploy from
 *  a checkout that had run the gate turned in-process code execution on in prod and one from a
 *  clean worktree turned it off. Under `NODE_ENV=production` the rung now needs
 *  `OPENWOP_CODE_EXEC_RUNTIME=wasi`, which is what the Dockerfile comment always said. Outside
 *  production the asset-present default stands. */
let optInNoticeLogged = false;
export function wasiRuntimeEnabled(): boolean {
  const runtime = (process.env.OPENWOP_CODE_EXEC_RUNTIME ?? '').trim().toLowerCase();
  if (runtime === 'off' || runtime === 'none' || runtime === 'disabled') return false; // explicit opt-out
  if (!existsSync(wasmPath())) return false;
  if (process.env.NODE_ENV === 'production' && runtime !== 'wasi') {
    if (!optInNoticeLogged) {
      optInNoticeLogged = true;
      log.info('code_exec_wasi_requires_optin', { hint: 'set OPENWOP_CODE_EXEC_RUNTIME=wasi to run code in-process in production' });
    }
    return false;
  }
  return true;
}

/** ADR 0995 AR-1 — the WASI rung's own concurrency cap. Its memory is OURS (the instance's),
 *  unlike the external adapters', so the shared cap of 8 would let 8 × the per-run memory cap
 *  exceed the instance. The aggregate an operator sizes against is
 *  `concurrency × (mem cap + scratch cap + ~40 MB worker/module overhead)`. */
function maxConcurrent(): number {
  const n = parseInt(process.env.OPENWOP_CODE_EXEC_WASI_MAX_CONCURRENT ?? '2', 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}
/** ADR 0995 D3 — the guest's linear-memory ceiling, MB (default 256). It used to size only the
 *  worker's JS heap (`maxOldGenerationSizeMb`), which does not bound wasm memory at all. */
function workerMemoryMb(): number {
  const n = parseInt(process.env.OPENWOP_CODE_EXEC_WASI_MEM_MB ?? '256', 10);
  return Number.isFinite(n) && n >= 64 ? n : 256;
}
/** ADR 0995 D4 — the host-measured ceiling on what one execution may write (guest /tmp plus the
 *  captured stdout/stderr), MB, and on how many entries the guest may create. */
function maxScratchBytes(): number {
  const n = parseInt(process.env.OPENWOP_CODE_EXEC_MAX_SCRATCH_MB ?? '64', 10);
  return (Number.isFinite(n) && n > 0 ? n : 64) * 1024 * 1024;
}
const MAX_SCRATCH_ENTRIES = 2_000;
const WATCHDOG_INTERVAL_MS = 100;
function maxOutputBytes(): number {
  const n = parseInt(process.env.OPENWOP_CODE_EXEC_MAX_OUTPUT_BYTES ?? String(DEFAULT_MAX_OUTPUT_BYTES), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_OUTPUT_BYTES;
}
let inFlight = 0;

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const WASM_PAGE_BYTES = 65_536;
const WASM32_MAX_PAGES = 65_536;

function readLeb(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let p = at;
  for (;;) {
    if (p >= bytes.length || shift > 28) throw new Error('wasm: malformed LEB128');
    const b = bytes[p++]!;
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if ((b & 0x80) === 0) return { value, next: p };
  }
}

function leb(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

/** ADR 0995 D3 — return a copy of a wasm binary whose ONE defined memory has `maxPages` as its
 *  maximum (the guest's `memory.grow` past it returns -1, so CPython raises MemoryError). Throws
 *  unless the module defines exactly one plain 32-bit, non-shared memory (flags 0 or 1) and
 *  imports none — anything else is refused rather than run unbounded. A pure function of its
 *  inputs. */
export function capWasmMemory(bytes: Uint8Array, maxPages: number): Uint8Array {
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error('wasm: not a module');
  let p = 8;
  let found: { start: number; end: number; min: number; declaredMax?: number } | undefined;
  while (p < bytes.length) {
    const id = bytes[p]!;
    const { value: len, next } = readLeb(bytes, p + 1);
    const end = next + len;
    if (end > bytes.length) throw new Error('wasm: truncated section');
    if (id === 2) {
      // Import section: refuse an imported memory (its limits are not ours to set).
      let q = next;
      const { value: count, next: q1 } = readLeb(bytes, q); q = q1;
      for (let i = 0; i < count; i++) {
        const m = readLeb(bytes, q); q = m.next + m.value;
        const f = readLeb(bytes, q); q = f.next + f.value;
        const kind = bytes[q++];
        if (kind === 0x02) throw new Error('wasm: imported memory');
        if (kind === 0x00) { q = readLeb(bytes, q).next; }
        else if (kind === 0x01) { q += 1; const fl = readLeb(bytes, q); q = readLeb(bytes, fl.next).next; if (fl.value & 1) q = readLeb(bytes, q).next; }
        else if (kind === 0x03) { q += 2; }
        else if (kind === 0x04) { q += 1; q = readLeb(bytes, q).next; }
        else throw new Error('wasm: unknown import kind');
      }
    }
    if (id === 5) {
      const { value: count, next: q } = readLeb(bytes, next);
      if (count !== 1 || found) throw new Error('wasm: expected exactly one memory');
      const flags = readLeb(bytes, q);
      if (flags.value !== 0 && flags.value !== 1) throw new Error('wasm: unsupported memory flags');
      const min = readLeb(bytes, flags.next);
      let after = min.next;
      let declaredMax: number | undefined;
      if (flags.value === 1) { const mx = readLeb(bytes, after); declaredMax = mx.value; after = mx.next; }
      if (after !== end) throw new Error('wasm: unexpected memory section layout');
      found = { start: p, end, min: min.value, ...(declaredMax !== undefined ? { declaredMax } : {}) };
    }
    p = end;
  }
  if (!found) throw new Error('wasm: no memory section');
  // wasm32 addresses at most 65 536 pages (4 GiB); a module's own smaller maximum stands.
  const max = Math.min(maxPages, WASM32_MAX_PAGES, found.declaredMax ?? WASM32_MAX_PAGES);
  if (found.min > max) throw new Error('wasm: memory minimum exceeds the cap');
  const body = [...leb(1), 0x01, ...leb(found.min), ...leb(max)];
  const section = [0x05, ...leb(body.length), ...body];
  const out = new Uint8Array(bytes.length - (found.end - found.start) + section.length);
  out.set(bytes.subarray(0, found.start), 0);
  out.set(section, found.start);
  out.set(bytes.subarray(found.end), found.start + section.length);
  return out;
}

/** Compile the 25 MB module ONCE per memory cap in the host and reuse it; `WebAssembly.Module` is
 *  structured-cloneable across the worker boundary, so each fresh worker only instantiates (no
 *  25 MB re-read). Keyed by the cap (ADR 0995 D3), so a changed knob compiles a new module. */
const compiled = new Map<number, Promise<object>>();
function compiledModule(maxPages: number): Promise<object> {
  let m = compiled.get(maxPages);
  if (!m) {
    // A binary the rewrite refuses (or that does not compile) is a host fault, not an execution:
    // it surfaces as the pre-dispatch `capability_not_provided`, so the runner releases the
    // budget reservation, and the failure is cached so each call does not re-read 25 MB.
    m = Promise.resolve()
      .then(() => WebAssembly.compile(capWasmMemory(readFileSync(wasmPath()), maxPages)))
      .catch((e: unknown) => {
        log.error('code_exec_wasi_unavailable', { reason: e instanceof Error ? e.message : String(e) });
        throw err('capability_not_provided', 'the in-process code runtime could not be loaded on this host.');
      });
    m.catch(() => { /* observed by each caller */ });
    compiled.set(maxPages, m);
  }
  return m;
}

/** ADR 0995 D4 — the bytes and entries under `dir`, stopping as soon as either cap is passed
 *  (the tree is guest-controlled, so the walk must be bounded too). Symlinks are not followed. */
async function scratchUsage(dir: string, byteCap: number): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    let names: string[];
    try { names = await readdir(d); } catch { continue; }
    entries += names.length;
    if (entries > MAX_SCRATCH_ENTRIES) return { bytes, entries };
    // One directory's entries are stat'ed together, so a tick costs one round of I/O per level,
    // not one per file (architect M4: a serial walk of a large tree outlived its interval).
    const stats = await Promise.all(names.map((name) => lstat(join(d, name)).then((st) => ({ p: join(d, name), st }), () => null)));
    for (const x of stats) {
      if (!x) continue; // vanished between readdir and lstat
      if (x.st.isDirectory()) stack.push(x.p);
      else bytes += x.st.size;
    }
    if (bytes > byteCap) return { bytes, entries };
  }
  return { bytes, entries };
}

/** ADR 0995 D4 (review H1) — bytes held by files under `dir` that are still OPEN but no longer
 *  LINKED. A guest can `open` a scratch file, `unlink` it and keep writing: the directory walk no
 *  longer sees it, yet on tmpfs it still holds RAM. Linux exposes every open descriptor of this
 *  process under `/proc/self/fd`, whose link text names the file plus ` (deleted)` once unlinked,
 *  and whose `stat` reaches the open file itself. Elsewhere (no `/proc`, e.g. macOS dev) it
 *  returns 0: there the wall clock is the bound, which the ADR states. */
export async function unlinkedOpenBytes(dir: string, procFdDir = '/proc/self/fd'): Promise<number> {
  let fds: string[];
  try { fds = await readdir(procFdDir); } catch { return 0; }
  const prefix = `${dir}/`;
  const sizes = await Promise.all(fds.map(async (fd) => {
    try {
      const target = await readlink(join(procFdDir, fd));
      if (!target.startsWith(prefix) || !target.endsWith(' (deleted)')) return 0;
      return (await stat(join(procFdDir, fd))).size;
    } catch { return 0; }
  }));
  return sizes.reduce((a, b) => a + b, 0);
}

/** ADR 0995 D4 (review H1) — after a worker is terminated, close every descriptor of this process
 *  that still points under its scratch `dir`. A killed worker does not close what it opened (the
 *  capture fds, and any file the guest held), and an unlinked file stays in tmpfs for as long as a
 *  descriptor holds it, so removing the directory alone would not free it. Linux only; a no-op
 *  where `/proc` is absent. Safe: once the worker is gone, nothing else holds these fds. */
export async function closeFdsUnder(dir: string, procFdDir = '/proc/self/fd'): Promise<number> {
  let fds: string[];
  try { fds = await readdir(procFdDir); } catch { return 0; }
  const prefix = `${dir}/`;
  let closed = 0;
  for (const fd of fds) {
    try {
      const target = await readlink(join(procFdDir, fd));
      if (target.startsWith(prefix)) { closeSync(Number(fd)); closed++; }
    } catch { /* already closed */ }
  }
  return closed;
}

/** The worker body (CJS eval-worker). Instantiates the (transferred) module under `node:wasi` with
 *  NO env, a fresh scratch preopened as `/tmp`, and captured stdout/stderr/stdin fds. No `js` bridge
 *  exists; the guest can reach only what WASI grants. */
const WORKER_SOURCE = `
// node:wasi emits an ExperimentalWarning on construction; suppress ONLY that one (a fresh worker per
// exec would otherwise spam it). Everything else still warns.
const _emit = process.emitWarning;
process.emitWarning = (w, ...a) => {
  const m = typeof w === 'string' ? w : (w && w.message) || '';
  if (/WASI is an experimental feature/i.test(m)) return;
  return _emit.call(process, w, ...a);
};
const { parentPort } = require('node:worker_threads');
const { WASI } = require('node:wasi');
const fs = require('node:fs');
// Read at most \`cap\` bytes so a guest that prints a huge volume cannot OOM the host on read-back.
function readCapped(p, cap) {
  try {
    const fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, cap);
    const buf = Buffer.alloc(n);
    if (n > 0) fs.readSync(fd, buf, 0, n, 0);
    fs.closeSync(fd);
    let s = buf.toString('utf8');
    if (size > cap) s += '\\n…[output truncated at ' + cap + ' bytes]';
    return s;
  } catch (_) { return ''; }
}
parentPort.once('message', async (msg) => {
  // The HOST owns \`base\` (created before this worker, removed after it on every exit path,
  // including a wall-clock kill — ADR 0995 D4). It holds the capture plumbing OUTSIDE the guest's
  // view; the guest's /tmp is the empty \`tmp\` SUBDIR, so the sandboxed code cannot see or forge
  // stdout/stderr/stdin. WASI's capability model already denies ../ + symlink escape out of the
  // preopen.
  const outFd = fs.openSync(msg.outP, 'w+'), errFd = fs.openSync(msg.errP, 'w+'), inFd = fs.openSync(msg.inP, 'r');
  let exitCode = 1;
  try {
    const wasi = new WASI({
      version: 'preview1',
      args: ['python', '-c', msg.code],
      env: {},
      preopens: { '/tmp': msg.guestTmp },   // fresh empty subdir → guest /tmp; capture files are NOT visible
      stdin: inFd, stdout: outFd, stderr: errFd,
      returnOnExit: true,
    });
    const instance = await WebAssembly.instantiate(msg.mod, wasi.getImportObject());
    exitCode = wasi.start(instance);
  } catch (e) {
    try { fs.writeSync(errFd, '\\n' + (e && e.message ? String(e.message) : 'sandbox_error')); } catch (_) {}
  }
  const out = readCapped(msg.outP, msg.maxOutput), errOut = readCapped(msg.errP, msg.maxOutput);
  try { fs.closeSync(outFd); fs.closeSync(errFd); fs.closeSync(inFd); } catch (_) {}
  parentPort.postMessage({ exitCode, stdout: out, stderr: errOut });
});
`;

/** Run one Python submission in a fresh CPython-WASI worker, host-terminated at the wall-clock cap. */
export async function runWasiSandboxedCode(req: SandboxExecRequest): Promise<SandboxExecResult> {
  // ADR 0556 P1 — metered inside the EXPORTED function so the reference
  // `resolveSandboxExecutor` hands out is unchanged (the Phase-8 selector tests
  // assert on it). `exitCode: 124` / `timedOut` is how this runtime reports a
  // wall-clock kill; it resolves rather than throwing, so the throw path alone
  // would miss every WASI timeout.
  try {
    const result = await runWasiSandbox(req);
    recordSandboxExecution('wasi', result.timedOut ? 'timeout' : 'ok');
    return result;
  } catch (err_) {
    recordSandboxExecution('wasi', classifySandboxError(err_));
    throw err_;
  }
}

async function runWasiSandbox(req: SandboxExecRequest): Promise<SandboxExecResult> {
  if (typeof req.code !== 'string' || req.code.length === 0) throw err('validation_error', '`code` is required.');
  if (req.code.length > MAX_CODE_BYTES) throw err('content_too_long', `code exceeds the ${MAX_CODE_BYTES}-byte cap.`);
  if (typeof req.stdin === 'string' && req.stdin.length > MAX_STDIN_BYTES) throw err('content_too_long', `stdin exceeds the ${MAX_STDIN_BYTES}-byte cap.`);
  const language = (req.language || 'python').toLowerCase();
  if (!WASI_LANGUAGES.includes(language)) throw err('validation_error', `language "${language}" is not supported by the WASI sandbox (Python only).`);

  if (inFlight >= maxConcurrent()) throw Object.assign(new Error('code execution is at capacity; try again shortly.'), { code: 'resource_exhausted' });
  inFlight++;

  const timeoutMs = Math.min(typeof req.timeoutMs === 'number' && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const byteCap = maxScratchBytes();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let worker: Worker | undefined;
  let base: string | undefined;
  // ADR 0995 D4 — ONE cleanup for every exit path (result, error, exit, wall-clock kill, disk
  // kill, a throw before the worker starts). It awaits the worker's termination BEFORE removing
  // the scratch dir; the dir used to be removed inside the worker, so a killed worker left it, and
  // everything the guest wrote, in the host's tmpfs.
  let cleaned: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (!cleaned) {
      if (timer) clearTimeout(timer);
      if (watchdog) clearInterval(watchdog);
      const w = worker;
      const dir = base;
      cleaned = (async () => {
        try {
          if (w) await w.terminate().catch(() => 0);
          if (dir) {
            await closeFdsUnder(dir).catch(() => 0);
            await rm(dir, { recursive: true, force: true }).catch(() => {});
          }
        } finally {
          // The slot is released only once the worker and its scratch are gone (review M2), so
          // the AR-1 aggregate bound holds across a kill.
          inFlight--;
        }
      })();
    }
    return cleaned;
  };

  try {
    const mod = await compiledModule(workerMemoryMb() * (1024 * 1024 / WASM_PAGE_BYTES));
    // Real path: `/proc/self/fd` link text is canonical, so the fd scans must match it exactly.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'owp-wasi-')));
    const paths = { guestTmp: join(base, 'tmp'), outP: join(base, 'stdout'), errP: join(base, 'stderr'), inP: join(base, 'stdin') };
    mkdirSync(paths.guestTmp);
    writeFileSync(paths.inP, typeof req.stdin === 'string' ? req.stdin : '');
    const scratch = base;
    const result = await new Promise<SandboxExecResult>((resolve) => {
      const done = (r: SandboxExecResult): void => { if (settled) return; settled = true; void cleanup(); resolve(r); };
      worker = new Worker(WORKER_SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 } });
      // Wall-clock: the HOST terminate kills even a tight infinite loop (escape-proof).
      timer = setTimeout(() => done({ exitCode: 124, stdout: '', stderr: '', timedOut: true, files: [] }), timeoutMs);
      // ADR 0995 D4 — the disk watchdog. Async, never overlapping itself, bounded walk. It can
      // overshoot the cap by what a guest writes in one interval; that residual is stated.
      let measuring = false;
      watchdog = setInterval(() => {
        if (measuring || settled) return;
        measuring = true;
        void Promise.all([scratchUsage(scratch, byteCap), unlinkedOpenBytes(scratch)]).then(([u, hidden]) => {
          if (!settled && (u.bytes + hidden > byteCap || u.entries > MAX_SCRATCH_ENTRIES)) {
            done({ exitCode: 1, stdout: '', stderr: 'sandbox_disk_limit', timedOut: false, files: [] });
          }
        }).finally(() => { measuring = false; });
      }, WATCHDOG_INTERVAL_MS);
      worker.on('message', (m: { exitCode?: number; stdout?: string; stderr?: string }) => {
        done({ exitCode: m.exitCode ?? 1, stdout: m.stdout ?? '', stderr: m.stderr ?? '', timedOut: false, files: [] });
      });
      worker.on('error', () => done({ exitCode: 1, stdout: '', stderr: 'sandbox_error', timedOut: false, files: [] }));
      worker.on('exit', (code) => { if (!settled) done({ exitCode: 1, stdout: '', stderr: code === 0 ? 'sandbox_exit' : 'sandbox_resource_exhausted', timedOut: false, files: [] }); });
      worker.postMessage({ code: req.code, mod, maxOutput: maxOutputBytes(), ...paths });
    });
    await cleanup();
    log.info('code_exec_dispatched', { runtime: 'wasi', language, exitCode: result.exitCode, timedOut: result.timedOut });
    return result;
  } finally {
    await cleanup();
  }
}
