/**
 * ADR 0114 Phase 2 — external Code-API sandbox adapter.
 * Honest-off unless configured; SSRF-guarded; §D endpoint non-disclosure.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSandboxRunner, runSandboxedCode , allowedLanguages } from '../src/host/sandboxAdapter.js';

let mock: http.Server;
let endpoint: string;

beforeAll(async () => {
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { code?: string };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ exitCode: 0, stdout: `ran:${body.code}`, stderr: '', files: [] }));
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  endpoint = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/exec`;
});
afterAll(async () => { await new Promise<void>((r) => mock.close(() => r())); });
// These tests exercise the EXTERNAL Code-API adapter path; opt OUT of the in-process WASI runtime
// (on by default when the asset is vendored) so "honest-off with no endpoint" stays observable.
beforeEach(() => { delete process.env.OPENWOP_CODE_EXEC_ENDPOINT; delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE; process.env.OPENWOP_CODE_EXEC_RUNTIME = 'off'; });
afterAll(() => { delete process.env.OPENWOP_CODE_EXEC_RUNTIME; });

describe('sandbox adapter', () => {
  it('honest-off: createSandboxRunner is undefined with no endpoint (WASI opted out)', () => {
    expect(createSandboxRunner()).toBeUndefined();
  });

  it('is wired when an endpoint is configured', () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = endpoint;
    expect(typeof createSandboxRunner()).toBe('function');
  });

  it('dispatches to the configured endpoint and returns the result', async () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = endpoint;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // loopback mock
    const r = await runSandboxedCode({ language: 'python', code: 'print(1)' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('ran:print(1)');
  });

  it('rejects empty code (validation)', async () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = endpoint;
    await expect(runSandboxedCode({ language: 'python', code: '' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('SSRF: a private endpoint is blocked without allow-private (and §D: no URL leak)', async () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = endpoint; // loopback = private, allow-private NOT set
    try {
      await runSandboxedCode({ language: 'python', code: 'print(1)' });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toBe('sandbox_transport_error'); // generic — endpoint host/port NOT echoed (§D)
      expect(msg).not.toContain('127.0.0.1');
    }
  });
});

describe('ADR 0114 hardening — stdin cap + concurrency (CXE-4/CXE-5)', () => {
  it('CXE-5: rejects oversize stdin (content_too_long)', async () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = endpoint;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    await expect(runSandboxedCode({ language: 'python', code: 'x=1', stdin: 'a'.repeat(200_001) }))
      .rejects.toMatchObject({ code: 'content_too_long' });
  });

  it('CXE-4: fails fast over the concurrency cap (resource_exhausted)', async () => {
    const slow = http.createServer((_req, res) => {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ exitCode: 0, stdout: '', stderr: '', files: [] })); }, 80);
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/exec`;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    process.env.OPENWOP_CODE_EXEC_MAX_CONCURRENT = '2';
    try {
      // 5 concurrent dispatches against a slow endpoint, cap 2 → 2 grab slots, 3 fail fast.
      const results = await Promise.all(Array.from({ length: 5 }, () =>
        runSandboxedCode({ language: 'python', code: 'x' }).then(() => 'ok').catch((e) => (e as { code?: string }).code)));
      expect(results.filter((r) => r === 'resource_exhausted').length).toBeGreaterThanOrEqual(1);
      expect(results.filter((r) => r === 'ok').length).toBeGreaterThan(0);
    } finally {
      delete process.env.OPENWOP_CODE_EXEC_MAX_CONCURRENT;
      delete process.env.OPENWOP_CODE_EXEC_ENDPOINT;
      delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
      await new Promise<void>((r) => slow.close(() => r()));
    }
  });
});

describe('ADR 0114 Phase 7 — language allowlist', () => {
  it('defaults to the common interpreters', () => {
    expect(allowedLanguages()).toContain('python');
    expect(allowedLanguages()).toContain('javascript');
  });
  it('rejects an unlisted language BEFORE any egress (validation_error)', async () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = 'http://127.0.0.1:1/never';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    try {
      const { runSandboxedCode } = await import('../src/host/sandboxAdapter.js');
      await runSandboxedCode({ language: 'malbolge', code: 'x' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('validation_error');
    } finally {
      delete process.env.OPENWOP_CODE_EXEC_ENDPOINT;
      delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    }
  });
});

