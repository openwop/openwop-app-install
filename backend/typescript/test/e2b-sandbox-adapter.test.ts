/**
 * ADR 0114 Phase 8 — first-party E2B sandbox adapter.
 * Selector precedence + response mapping + SSRF host-pin + §D scrub, all with a MOCKED undici
 * fetch (no network). Verifies the E2B executor is SELECTED (and thus rides createSandboxRunner's
 * budget/concurrency wrapper) and maps E2B responses onto SandboxExecResult correctly.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Mock undici's `fetch` only — keep the real `Agent`/`Response` (the SSRF dispatcher + Response
// construction stay functional). e2bAdapter + sandboxAdapter both read this same mocked binding.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});

import { fetch, Response } from 'undici';
import {
  createSandboxRunner,
  codeExecProvider,
  e2bConfigured,
} from '../src/host/sandboxAdapter.js';
import { runSandboxedCode } from '../src/host/sandboxAdapter.js';
import { runE2bSandboxedCode } from '../src/host/sandboxAdapters/e2bAdapter.js';
import { runWasiSandboxedCode } from '../src/host/wasiSandbox.js';

const mockedFetch = vi.mocked(fetch);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ENV_KEYS = [
  'OPENWOP_CODE_EXEC_PROVIDER', 'OPENWOP_E2B_API_KEY', 'OPENWOP_CODE_EXEC_ENDPOINT',
  'OPENWOP_CODE_EXEC_RUNTIME', 'OPENWOP_CODE_EXEC_WASM_PATH', 'OPENWOP_WEBHOOK_ALLOW_PRIVATE',
  'OPENWOP_CODE_EXEC_LANGUAGES',
];
beforeEach(() => {
  mockedFetch.mockReset();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.OPENWOP_CODE_EXEC_RUNTIME = 'off'; // opt out of WASI unless a test flips it on
});
afterAll(() => { for (const k of ENV_KEYS) delete process.env[k]; });

describe('ADR 0114 Phase 8 — selector precedence', () => {
  it('provider=e2b + key → the E2B executor is selected (rides createSandboxRunner)', () => {
    process.env.OPENWOP_CODE_EXEC_PROVIDER = 'e2b';
    process.env.OPENWOP_E2B_API_KEY = 'e2b_secret';
    expect(codeExecProvider()).toBe('e2b');
    expect(e2bConfigured()).toBe(true);
    expect(createSandboxRunner()).toBe(runE2bSandboxedCode);
  });

  it('provider=e2b, NO key → falls through to the Code-API endpoint (honest-off, not a hard error)', () => {
    process.env.OPENWOP_CODE_EXEC_PROVIDER = 'e2b';
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = 'https://sandbox.example.com/exec';
    expect(e2bConfigured()).toBe(false);
    expect(createSandboxRunner()).toBe(runSandboxedCode);
  });

  it('provider=e2b, NO key, nothing else configured → honest-off (undefined)', () => {
    process.env.OPENWOP_CODE_EXEC_PROVIDER = 'e2b';
    expect(createSandboxRunner()).toBeUndefined();
  });

  it('provider unset + endpoint → the Code-API adapter', () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = 'https://sandbox.example.com/exec';
    expect(createSandboxRunner()).toBe(runSandboxedCode);
  });

  it('provider unset + WASI enabled → the WASI runtime', () => {
    // Force WASI on by pointing the asset path at an existing file (the wasm asset guard).
    process.env.OPENWOP_CODE_EXEC_RUNTIME = 'wasi';
    process.env.OPENWOP_CODE_EXEC_WASM_PATH = new URL(import.meta.url).pathname;
    expect(createSandboxRunner()).toBe(runWasiSandboxedCode);
  });
});

describe('ADR 0114 Phase 8 — runE2bSandboxedCode response mapping', () => {
  beforeEach(() => { process.env.OPENWOP_E2B_API_KEY = 'e2b_secret'; });

  it('maps a mocked E2B success response → SandboxExecResult (exit/stdout/stderr/files)', async () => {
    mockedFetch.mockImplementation(async (input) => {
      const u = String(input);
      if (u.endsWith('/sandboxes')) return jsonResponse(200, { sandboxID: 'sbx1', domain: 'e2b.dev' });
      if (u.includes('/exec')) {
        return jsonResponse(200, {
          exitCode: 0, stdout: 'hello\n', stderr: '',
          files: [{ name: 'out.txt', mimeType: 'text/plain', base64: 'aGk=' }],
        });
      }
      return jsonResponse(200, {}); // DELETE teardown
    });
    const r = await runE2bSandboxedCode({ language: 'python', code: 'print("hello")' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello\n');
    expect(r.stderr).toBe('');
    expect(r.files).toEqual([{ name: 'out.txt', mimeType: 'text/plain', base64: 'aGk=' }]);
    // create + exec (+ best-effort delete) all went through the mocked (SSRF-pinned) fetch.
    const createCalled = mockedFetch.mock.calls.some((c) => String(c[0]).endsWith('/sandboxes'));
    const execCalled = mockedFetch.mock.calls.some((c) => String(c[0]).includes('/exec'));
    expect(createCalled && execCalled).toBe(true);
  });

  it('a non-zero E2B exec exit maps through (exitCode preserved)', async () => {
    mockedFetch.mockImplementation(async (input) => {
      const u = String(input);
      if (u.endsWith('/sandboxes')) return jsonResponse(200, { sandboxID: 'sbx1', domain: 'e2b.dev' });
      if (u.includes('/exec')) return jsonResponse(200, { exitCode: 3, stdout: '', stderr: 'boom' });
      return jsonResponse(200, {});
    });
    const r = await runE2bSandboxedCode({ language: 'python', code: 'raise SystemExit(3)' });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe('boom');
  });

  it('an error status with no body maps to a non-zero exit', async () => {
    mockedFetch.mockImplementation(async (input) => {
      const u = String(input);
      if (u.endsWith('/sandboxes')) return jsonResponse(200, { sandboxID: 'sbx1', domain: 'e2b.dev' });
      if (u.includes('/exec')) return jsonResponse(500, {});
      return jsonResponse(200, {});
    });
    const r = await runE2bSandboxedCode({ language: 'python', code: 'x' });
    expect(r.exitCode).toBe(1);
  });
});

describe('ADR 0114 Phase 8 — SSRF host-pin + §D scrub', () => {
  beforeEach(() => { process.env.OPENWOP_E2B_API_KEY = 'e2b_secret'; });

  it('rejects a per-sandbox host that is NOT under e2b.dev (host-pin) with no host/key leak', async () => {
    mockedFetch.mockImplementation(async (input) => {
      const u = String(input);
      // control-plane create succeeds but hands back a hostile off-eTLD domain
      if (u.endsWith('/sandboxes')) return jsonResponse(200, { sandboxID: 'sbx1', domain: 'evil.example.com' });
      return jsonResponse(200, { exitCode: 0, stdout: 'pwned', stderr: '' });
    });
    await expect(runE2bSandboxedCode({ language: 'python', code: 'x' })).rejects.toMatchObject({ code: 'sandbox_transport_error' });
    try {
      await runE2bSandboxedCode({ language: 'python', code: 'x' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toBe('sandbox_transport_error');
      expect(msg).not.toContain('evil.example.com');
      expect(msg).not.toContain('e2b_secret');
      expect(msg).not.toContain('sbx1');
    }
  });

  it('rejects a private/loopback per-sandbox host (deny-private)', async () => {
    mockedFetch.mockImplementation(async (input) => {
      const u = String(input);
      if (u.endsWith('/sandboxes')) return jsonResponse(200, { sandboxID: '127', domain: '0.0.1' });
      return jsonResponse(200, { exitCode: 0, stdout: '', stderr: '' });
    });
    await expect(runE2bSandboxedCode({ language: 'python', code: 'x' })).rejects.toMatchObject({ code: 'sandbox_transport_error' });
  });

  it('a timeout/abort surfaces as sandbox_timeout with no host/key leak', async () => {
    mockedFetch.mockImplementation(async (input) => {
      const u = String(input);
      if (u.endsWith('/sandboxes')) return jsonResponse(200, { sandboxID: 'sbx1', domain: 'e2b.dev' });
      if (u.includes('/exec')) { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }
      return jsonResponse(200, {});
    });
    try {
      await runE2bSandboxedCode({ language: 'python', code: 'x' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('sandbox_transport_error');
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toBe('sandbox_timeout');
      expect(msg).not.toContain('e2b_secret');
    }
  });
});

describe('ADR 0114 Phase 8 — language gate before egress', () => {
  it('rejects an unlisted language BEFORE any egress (validation_error, no fetch)', async () => {
    process.env.OPENWOP_E2B_API_KEY = 'e2b_secret';
    process.env.OPENWOP_CODE_EXEC_LANGUAGES = 'python,javascript';
    mockedFetch.mockImplementation(async () => jsonResponse(200, {}));
    await expect(runE2bSandboxedCode({ language: 'malbolge', code: 'x' })).rejects.toMatchObject({ code: 'validation_error' });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('a missing key is honest-off (capability_not_provided), no fetch', async () => {
    // no OPENWOP_E2B_API_KEY set
    mockedFetch.mockImplementation(async () => jsonResponse(200, {}));
    await expect(runE2bSandboxedCode({ language: 'python', code: 'x' })).rejects.toMatchObject({ code: 'capability_not_provided' });
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
