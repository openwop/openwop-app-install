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
 *  - memory: BEST-EFFORT under `node:wasi` — the module exports its own memory and V8 cannot cap its
 *    growth, so a large alloc can OOM the worker/host. NOTE on Cloud Run gen2 `/tmp` is tmpfs (RAM),
 *    so guest writes to the scratch ALSO consume instance memory — same bound. Bounded operationally
 *    by the CXE-4 concurrency cap + wall-clock + the HITL gate + instance sizing; output read-back is
 *    capped (`OPENWOP_CODE_EXEC_MAX_OUTPUT_BYTES`) so a huge print can't OOM the host. A runtime-
 *    enforced ceiling needs native Wasmtime `StoreLimits` (ADR 0146 Phase 4b). Stated, not hidden.
 *  - capture plumbing (stdout/stderr/stdin files) lives OUTSIDE the preopen, so the guest can neither
 *    read its own stdin file nor forge/truncate the captured output.
 *  - a FRESH worker + scratch dir per execution ⇒ no state/leak between runs; scratch is removed.
 *
 * Python-only. REPLAY-NEUTRAL: runs only on live execution; the result is recorded as a
 * `code.execution-result` artifact (ADR 0114) and replay/`:fork` read that verbatim.
 * `node:wasi` is flagged experimental in Node — pin Node + keep the escape suite a CI gate.
 */
import { Worker } from 'node:worker_threads';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createLogger } from '../observability/logger.js';
import { locateRepoDir } from './_repoPath.js';
import type { SandboxExecRequest, SandboxExecResult } from '../executor/types.js';

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
 *  `sync-pythonwasm.sh` honest-off (no false advertisement). Each run is still HITL-gated + budgeted. */
export function wasiRuntimeEnabled(): boolean {
  const runtime = (process.env.OPENWOP_CODE_EXEC_RUNTIME ?? '').trim().toLowerCase();
  if (runtime === 'off' || runtime === 'none' || runtime === 'disabled') return false; // explicit opt-out
  return existsSync(wasmPath());
}

function maxConcurrent(): number {
  const n = parseInt(process.env.OPENWOP_CODE_EXEC_MAX_CONCURRENT ?? '8', 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
}
function workerMemoryMb(): number {
  const n = parseInt(process.env.OPENWOP_CODE_EXEC_WASI_MEM_MB ?? '512', 10);
  return Number.isFinite(n) && n >= 64 ? n : 512;
}
function maxOutputBytes(): number {
  const n = parseInt(process.env.OPENWOP_CODE_EXEC_MAX_OUTPUT_BYTES ?? String(DEFAULT_MAX_OUTPUT_BYTES), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_OUTPUT_BYTES;
}
let inFlight = 0;

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Compile the 25 MB module ONCE in the host and reuse it; `WebAssembly.Module` is structured-
 *  cloneable across the worker boundary, so each fresh worker only instantiates (no 25 MB re-read). */
let cachedModule: Promise<object> | undefined;
function compiledModule(): Promise<object> {
  if (!cachedModule) cachedModule = WebAssembly.compile(readFileSync(wasmPath()));
  return cachedModule;
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
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
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
  // \`base\` holds the capture plumbing OUTSIDE the guest's view; the guest's /tmp is a fresh empty
  // SUBDIR, so the sandboxed code cannot see or forge stdout/stderr/stdin (they live in \`base\`, which
  // is NOT preopened). WASI's capability model already denies ../ + symlink escape out of the preopen.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'owp-wasi-'));
  const guestTmp = path.join(base, 'tmp'); fs.mkdirSync(guestTmp);
  const outP = path.join(base, 'stdout'), errP = path.join(base, 'stderr'), inP = path.join(base, 'stdin');
  fs.writeFileSync(inP, typeof msg.stdin === 'string' ? msg.stdin : '');
  const outFd = fs.openSync(outP, 'w+'), errFd = fs.openSync(errP, 'w+'), inFd = fs.openSync(inP, 'r');
  let exitCode = 1;
  try {
    const wasi = new WASI({
      version: 'preview1',
      args: ['python', '-c', msg.code],
      env: {},
      preopens: { '/tmp': guestTmp },   // fresh empty subdir → guest /tmp; capture files are NOT visible
      stdin: inFd, stdout: outFd, stderr: errFd,
      returnOnExit: true,
    });
    const instance = await WebAssembly.instantiate(msg.mod, wasi.getImportObject());
    exitCode = wasi.start(instance);
  } catch (e) {
    try { fs.writeSync(errFd, '\\n' + (e && e.message ? String(e.message) : 'sandbox_error')); } catch (_) {}
  }
  const out = readCapped(outP, msg.maxOutput), errOut = readCapped(errP, msg.maxOutput);
  try { fs.closeSync(outFd); fs.closeSync(errFd); fs.closeSync(inFd); fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
  parentPort.postMessage({ exitCode, stdout: out, stderr: errOut });
});
`;

/** Run one Python submission in a fresh CPython-WASI worker, host-terminated at the wall-clock cap. */
export async function runWasiSandboxedCode(req: SandboxExecRequest): Promise<SandboxExecResult> {
  if (typeof req.code !== 'string' || req.code.length === 0) throw err('validation_error', '`code` is required.');
  if (req.code.length > MAX_CODE_BYTES) throw err('content_too_long', `code exceeds the ${MAX_CODE_BYTES}-byte cap.`);
  if (typeof req.stdin === 'string' && req.stdin.length > MAX_STDIN_BYTES) throw err('content_too_long', `stdin exceeds the ${MAX_STDIN_BYTES}-byte cap.`);
  const language = (req.language || 'python').toLowerCase();
  if (!WASI_LANGUAGES.includes(language)) throw err('validation_error', `language "${language}" is not supported by the WASI sandbox (Python only).`);

  if (inFlight >= maxConcurrent()) throw Object.assign(new Error('code execution is at capacity; try again shortly.'), { code: 'resource_exhausted' });
  inFlight++;

  const timeoutMs = Math.min(typeof req.timeoutMs === 'number' && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let worker: Worker | undefined;
  const cleanup = (): void => { if (timer) clearTimeout(timer); if (worker) void worker.terminate(); inFlight--; };

  try {
    const mod = await compiledModule();
    return await new Promise<SandboxExecResult>((resolve) => {
      const done = (r: SandboxExecResult): void => { if (settled) return; settled = true; cleanup(); resolve(r); };
      worker = new Worker(WORKER_SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: workerMemoryMb() } });
      // Wall-clock: the HOST terminate kills even a tight infinite loop (escape-proof).
      timer = setTimeout(() => done({ exitCode: 124, stdout: '', stderr: '', timedOut: true, files: [] }), timeoutMs);
      worker.on('message', (m: { exitCode?: number; stdout?: string; stderr?: string }) => {
        done({ exitCode: m.exitCode ?? 1, stdout: m.stdout ?? '', stderr: m.stderr ?? '', timedOut: false, files: [] });
      });
      worker.on('error', () => done({ exitCode: 1, stdout: '', stderr: 'sandbox_error', timedOut: false, files: [] }));
      worker.on('exit', (code) => { if (!settled) done({ exitCode: 1, stdout: '', stderr: code === 0 ? 'sandbox_exit' : 'sandbox_resource_exhausted', timedOut: false, files: [] }); });
      worker.postMessage({ code: req.code, stdin: req.stdin, mod, maxOutput: maxOutputBytes() });
    }).then((r) => {
      log.info('code_exec_dispatched', { runtime: 'wasi', language, exitCode: r.exitCode, timedOut: r.timedOut });
      return r;
    });
  } finally {
    if (!settled) cleanup();
  }
}
