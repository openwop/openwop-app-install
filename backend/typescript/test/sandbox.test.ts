/**
 * A13 — real vm sandbox (RFC 0035). Verifies isolation + the failure taxonomy:
 * success, capability-denied, escape-attempt, timeout.
 */

import { describe, expect, it } from 'vitest';
import { runInSandbox } from '../src/host/sandbox.js';

describe('sandbox (A13 / RFC 0035)', () => {
  it('runs pure code and returns the value', () => {
    const r = runInSandbox('1 + 2 * 3');
    expect(r).toEqual({ ok: true, value: 7 });
  });

  it('allows only allow-listed host calls (capability gating)', () => {
    const ok = runInSandbox("host('kv.get', 'k')", { allowedHostCalls: ['kv.get'], hostCall: () => 'v' });
    expect(ok).toEqual({ ok: true, value: 'v' });

    const denied = runInSandbox("host('fs.read', '/etc/passwd')", { allowedHostCalls: ['kv.get'] });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('sandbox_capability_denied');
  });

  it('reports an escape attempt when reaching for ambient globals', () => {
    const r = runInSandbox("require('node:fs')");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('sandbox_escape_attempt');

    const p = runInSandbox('process.env.SECRET');
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error.code).toBe('sandbox_escape_attempt');
  });

  it('times out a runaway synchronous loop', () => {
    const r = runInSandbox('while (true) {}', { timeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('sandbox_timeout');
  });
});
