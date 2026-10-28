/**
 * ADR 0146 Phase 2 — adversarial escape-regression suite for the in-process CPython-WASI sandbox
 * (`host/wasiSandbox.ts`). THIS IS THE SECURITY GATE: it must run real executions and prove the
 * host-escape class that sank the reverted Pyodide path (#902/#904) is absent by construction.
 *
 * Unlike the Pyodide suite, this checks the FFI vectors directly (`import js`, subprocess, ctypes),
 * not just `os.environ`/`open()`.
 *
 * WHAT RUNS WHERE (CORRECTED wave 63 — this header used to say the suite "fails LOUD (not skip)"
 * when the asset is missing; the code SKIPS):
 *  - The execution, escape, output-cap and wall-clock blocks need the vendored runtime
 *    `vendor/python-3.12.0.wasm` (`scripts/sync-pythonwasm.sh`). Without it they are
 *    `describe.skip` with a console warning on a plain checkout. MEASURED 2026-10-23: the asset
 *    was absent from the local checkouts and `npm run ci` did not sync it, so the escape suite
 *    never ran in the gate (WASI-GATE-1). DECIDED 2026-10-24 (user): the gate fetches it.
 *    `scripts/ci.sh` and the Tracegate daemon run `scripts/sync-pythonwasm.sh` and set
 *    OPENWOP_REQUIRE_WASI=1, under which a missing asset FAILS this file instead of skipping it.
 *  - The selection/advertisement and input-validation cases need no runtime and run in every gate
 *    (the first describe below). The endpoint-precedence case points OPENWOP_CODE_EXEC_WASM_PATH
 *    at an existing stand-in file so WASI counts as enabled without executing anything.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runWasiSandboxedCode, wasiRuntimeEnabled, wasiAllowedLanguages, wasmPath } from '../src/host/wasiSandbox.js';
import { selectSandboxExecutor, allowedLanguages } from '../src/host/sandboxAdapter.js';

const T = 30_000;

// Asset-gated suite: CI/Docker sync the CPython-WASI binary; a plain local
// checkout usually hasn't. SKIP loudly instead of hard-failing — a missing
// vendor asset is an environment fact, not a code defect, and the hard throw
// made this the local baseline's permanent red (CI still runs the real gate).
const wasmPresent = existsSync(wasmPath());
if (!wasmPresent) {
  // eslint-disable-next-line no-console -- deliberate: the skip must be loud in local output
  console.warn(`⚠ wasi-sandbox suite SKIPPED — CPython-WASI asset missing at ${wasmPath()}; run scripts/sync-pythonwasm.sh to enable the escape gate locally.`);
}
// The gate requires the runtime (WASI-GATE-1): there, a missing asset is a broken sync, and a
// skip would record this security gate as green without running it.
if (!wasmPresent && process.env.OPENWOP_REQUIRE_WASI === '1') {
  throw new Error(`OPENWOP_REQUIRE_WASI=1 but the CPython-WASI asset is missing at ${wasmPath()} — run scripts/sync-pythonwasm.sh`);
}
const describeIfWasm = wasmPresent ? describe : describe.skip;
/** Any existing file: `wasiRuntimeEnabled()` only checks existence, and these cases never execute. */
const STAND_IN_WASM = fileURLToPath(import.meta.url);

beforeEach(() => {
  delete process.env.OPENWOP_CODE_EXEC_ENDPOINT;
  delete process.env.OPENWOP_CODE_EXEC_RUNTIME;
  delete process.env.OPENWOP_CODE_EXEC_WASM_PATH;
  delete process.env.OPENWOP_CODE_EXEC_LANGUAGES;
});

describeIfWasm('wasi sandbox — the vendored default path', () => {
  it('ON BY DEFAULT: asset present, no endpoint ⇒ runner wired, advertises python ONLY', () => {
    expect(wasiRuntimeEnabled()).toBe(true);                 // default-on (ADR 0146 OQ-1 reversed)
    expect(typeof selectSandboxExecutor()).toBe('function');
    expect(allowedLanguages()).toEqual(['python']);          // Phase 3 — advertise only what WASI honors
  });
});

describe('wasi sandbox — selection precedence & honest advertisement (no runtime needed)', () => {
  it('explicit opt-OUT: OPENWOP_CODE_EXEC_RUNTIME=off ⇒ honest-off, polyglot advertisement', () => {
    process.env.OPENWOP_CODE_EXEC_WASM_PATH = STAND_IN_WASM;  // a runtime IS present, so the opt-out is what turns it off
    process.env.OPENWOP_CODE_EXEC_RUNTIME = 'off';
    expect(wasiRuntimeEnabled()).toBe(false);
    expect(selectSandboxExecutor()).toBeUndefined();
    expect(allowedLanguages()).toContain('javascript');      // back to the external-adapter default list
  });

  it('asset MISSING ⇒ honest-off (no false advertisement)', () => {
    process.env.OPENWOP_CODE_EXEC_WASM_PATH = '/nonexistent/python.wasm';
    expect(wasiRuntimeEnabled()).toBe(false);
    expect(selectSandboxExecutor()).toBeUndefined();
  });

  it('external endpoint wins over the WASI default (strong-isolation path)', () => {
    process.env.OPENWOP_CODE_EXEC_WASM_PATH = STAND_IN_WASM;  // WASI enabled, so the precedence is real
    expect(wasiRuntimeEnabled(), 'precondition: WASI counts as enabled').toBe(true);
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = 'https://sandbox.example/exec';
    expect(typeof selectSandboxExecutor()).toBe('function');
    expect(allowedLanguages()).toContain('go');              // external polyglot default, not the WASI [python]
  });

  it('Python is the only advertised wasi language', () => {
    expect(wasiAllowedLanguages()).toEqual(['python']);
  });

  // Input caps: each is refused BEFORE any runtime load (`wasiSandbox.ts:187-191`), so these
  // need no asset and run in every gate.
  it('rejects a non-Python language (allowlist)', async () => {
    await expect(runWasiSandboxedCode({ language: 'javascript', code: 'console.log(1)' }))
      .rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('language "javascript" is not supported') });
  });

  it('rejects oversized code (size cap)', async () => {
    await expect(runWasiSandboxedCode({ language: 'python', code: 'x'.repeat(200_001) }))
      .rejects.toMatchObject({ code: 'content_too_long', message: expect.stringContaining('200000-byte cap') });
  });

  it('rejects empty code', async () => {
    await expect(runWasiSandboxedCode({ language: 'python', code: '' }))
      .rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('`code` is required.') });
  });
});

describeIfWasm('wasi sandbox — execution & I/O', () => {
  it('runs Python and captures stdout (exit 0)', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'print(6 * 7)' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('42');
    expect(r.timedOut).toBe(false);
  }, T);

  it('feeds stdin to the program', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'import sys; print(sys.stdin.read().strip().upper())', stdin: 'hello' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('HELLO');
  }, T);

  it('maps a Python exception to exit 1 with traceback in stderr (no host path)', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'raise ValueError("boom")' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('boom');
    expect(r.stderr).not.toMatch(/\/Users\/|\/home\/|node_modules|openwop-app/); // §D — no host path
  }, T);

  it('grants a writable, ISOLATED /tmp scratch (fresh per exec)', async () => {
    const w = await runWasiSandboxedCode({ language: 'python', code: 'open("/tmp/x","w").write("hi"); print(open("/tmp/x").read())' });
    expect(w.exitCode).toBe(0);
    expect(w.stdout).toContain('hi');
    // a SECOND exec must not see the first's file — fresh scratch per run
    const r2 = await runWasiSandboxedCode({ language: 'python', code: 'import os; print("LEAK" if os.path.exists("/tmp/x") else "ISOLATED")' });
    expect(r2.stdout).toContain('ISOLATED');
  }, T);
});

describeIfWasm('wasi sandbox — ESCAPE SUITE (the gate: all must be denied)', () => {
  beforeEach(() => { process.env.ESCAPE_SECRET = 'HOST-SECRET-XYZ'; });

  it('no js FFI bridge exists (the Pyodide escape class is absent)', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'import js; print(js.process.env)' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("No module named 'js'");
    expect(r.stdout).not.toContain('HOST-SECRET-XYZ');
  }, T);

  it('fs: cannot read a host file (no preopen)', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'print(open("/etc/passwd").read())' });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain('root:');
    expect(r.stderr).not.toContain('root:');
  }, T);

  it('env: host environment is invisible (we pass env:{})', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'import os; print("SECRET:", os.environ.get("ESCAPE_SECRET","ABSENT"), "count:", len(os.environ))' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('ABSENT');
    expect(r.stdout).not.toContain('HOST-SECRET-XYZ');
  }, T);

  it('network: no socket reaches out (wasi-preview1 has no sockets)', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'import socket; s=socket.socket(); s.connect(("1.1.1.1",80)); print("CONNECTED")' });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain('CONNECTED');
  }, T);

  it('subprocess: cannot spawn a host process', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'import subprocess; print(subprocess.run(["ls","/"],capture_output=True).stdout)' });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toMatch(/bin|etc|usr/);
  }, T);

  it('ctypes: native FFI is unavailable', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'import ctypes; print(ctypes.CDLL(None))' });
    expect(r.exitCode).toBe(1);
  }, T);

  // The load-bearing fs guarantee — WASI's capability model denies escape OUT of the /tmp preopen
  // (not a path blocklist). Regression-protect the vectors the original suite assumed.
  it('fs: `../` traversal cannot escape the /tmp preopen', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'print(open("/tmp/../../etc/passwd").read())' });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain('root:');
  }, T);

  it('fs: a symlink to a host path cannot be created/followed', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'import os; os.symlink("/etc/passwd","/tmp/lnk"); print(open("/tmp/lnk").read())' });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain('root:');
  }, T);

  it('fs: cannot enumerate the guest root `/`', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'import os; print(os.listdir("/"))' });
    expect(r.exitCode).toBe(1);
  }, T);

  it('fs: the capture plumbing is NOT visible in the guest /tmp', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'import os; print("FILES:", sorted(os.listdir("/tmp")))' });
    expect(r.exitCode).toBe(0);
    // a clean empty /tmp — stdout/stderr/stdin live OUTSIDE the preopen now
    expect(r.stdout).not.toMatch(/stdout|stderr|stdin/);
    expect(r.stdout).toContain('FILES: []');
  }, T);
});

describeIfWasm('wasi sandbox — output cap (host-OOM guard)', () => {
  it('caps captured stdout so a huge print cannot OOM the host', async () => {
    process.env.OPENWOP_CODE_EXEC_MAX_OUTPUT_BYTES = '50000';
    try {
      const r = await runWasiSandboxedCode({ language: 'python', code: 'print("A" * 5_000_000)' });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.length).toBeLessThan(60_000); // capped well under the 5 MB the guest printed
      expect(r.stdout).toContain('output truncated');
    } finally {
      delete process.env.OPENWOP_CODE_EXEC_MAX_OUTPUT_BYTES;
    }
  }, T);
});

describeIfWasm('wasi sandbox — wall-clock & input caps', () => {
  it('HOST-terminates a tight infinite loop → timedOut (the load-bearing guarantee)', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'while True: pass', timeoutMs: 1_500 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
  }, T);

});
