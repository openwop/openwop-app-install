/**
 * ADR 0146 Phase 2 — adversarial escape-regression suite for the in-process CPython-WASI sandbox
 * (`host/wasiSandbox.ts`). THIS IS THE SECURITY GATE: it must run real executions and prove the
 * host-escape class that sank the reverted Pyodide path (#902/#904) is absent by construction.
 *
 * Unlike the Pyodide suite, this checks the FFI vectors directly (`import js`, subprocess, ctypes),
 * not just `os.environ`/`open()`. Requires the vendored runtime — run `scripts/sync-pythonwasm.sh`
 * first (CI/Docker do). The suite fails LOUD (not skip) if the asset is missing — a gate must run.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { runWasiSandboxedCode, wasiRuntimeEnabled, wasiAllowedLanguages, wasmPath } from '../src/host/wasiSandbox.js';
import { createSandboxRunner, allowedLanguages } from '../src/host/sandboxAdapter.js';

const T = 30_000;

beforeAll(() => {
  if (!existsSync(wasmPath())) {
    throw new Error(`CPython-WASI asset missing at ${wasmPath()} — run scripts/sync-pythonwasm.sh (CI/Docker do). The escape gate cannot run without it.`);
  }
});

beforeEach(() => {
  delete process.env.OPENWOP_CODE_EXEC_ENDPOINT;
  delete process.env.OPENWOP_CODE_EXEC_RUNTIME;
  delete process.env.OPENWOP_CODE_EXEC_WASM_PATH;
  delete process.env.OPENWOP_CODE_EXEC_LANGUAGES;
});

describe('wasi sandbox — selection precedence & honest advertisement', () => {
  it('ON BY DEFAULT: asset present, no endpoint ⇒ runner wired, advertises python ONLY', () => {
    expect(wasiRuntimeEnabled()).toBe(true);                 // default-on (ADR 0146 OQ-1 reversed)
    expect(typeof createSandboxRunner()).toBe('function');
    expect(allowedLanguages()).toEqual(['python']);          // Phase 3 — advertise only what WASI honors
  });

  it('explicit opt-OUT: OPENWOP_CODE_EXEC_RUNTIME=off ⇒ honest-off, polyglot advertisement', () => {
    process.env.OPENWOP_CODE_EXEC_RUNTIME = 'off';
    expect(wasiRuntimeEnabled()).toBe(false);
    expect(createSandboxRunner()).toBeUndefined();
    expect(allowedLanguages()).toContain('javascript');      // back to the external-adapter default list
  });

  it('asset MISSING ⇒ honest-off (no false advertisement)', () => {
    process.env.OPENWOP_CODE_EXEC_WASM_PATH = '/nonexistent/python.wasm';
    expect(wasiRuntimeEnabled()).toBe(false);
    expect(createSandboxRunner()).toBeUndefined();
  });

  it('external endpoint wins over the WASI default (strong-isolation path)', () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = 'https://sandbox.example/exec';
    expect(typeof createSandboxRunner()).toBe('function');
    expect(allowedLanguages()).toContain('go');              // external polyglot default, not the WASI [python]
  });

  it('Python is the only advertised wasi language', () => {
    expect(wasiAllowedLanguages()).toEqual(['python']);
  });
});

describe('wasi sandbox — execution & I/O', () => {
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

describe('wasi sandbox — ESCAPE SUITE (the gate: all must be denied)', () => {
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

describe('wasi sandbox — output cap (host-OOM guard)', () => {
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

describe('wasi sandbox — wall-clock & input caps', () => {
  it('HOST-terminates a tight infinite loop → timedOut (the load-bearing guarantee)', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'while True: pass', timeoutMs: 1_500 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
  }, T);

  it('rejects a non-Python language (allowlist)', async () => {
    await expect(runWasiSandboxedCode({ language: 'javascript', code: 'console.log(1)' }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('rejects oversized code (size cap)', async () => {
    await expect(runWasiSandboxedCode({ language: 'python', code: 'x'.repeat(200_001) }))
      .rejects.toMatchObject({ code: 'content_too_long' });
  });

  it('rejects empty code', async () => {
    await expect(runWasiSandboxedCode({ language: 'python', code: '' }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });
});
