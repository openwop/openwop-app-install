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

  // Regression: node:vm is NOT escape-proof on its own — the classic break is
  // walking the prototype chain of any outer-realm object the sandbox can reach
  // (`x.constructor.constructor('return process')()`). The hardened primitive
  // keeps every reachable reference inside the vm realm, so these now surface as
  // ReferenceError → sandbox_escape_attempt rather than returning real `process`.
  describe('prototype-chain escape hardening (AGENTRT-1)', () => {
    it('blocks the host-function constructor escape', () => {
      const r = runInSandbox("host.constructor.constructor('return process')()", {
        allowedHostCalls: ['kv.get'],
        hostCall: () => 'v',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('sandbox_escape_attempt');
    });

    it('blocks the generic Function-constructor escape', () => {
      const r = runInSandbox("[].constructor.constructor('return process')()");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('sandbox_escape_attempt');
    });

    it('blocks escape via a host-call return value (results are context-native)', () => {
      const r = runInSandbox("host('kv.get','k').constructor.constructor('return process')()", {
        allowedHostCalls: ['kv.get'],
        hostCall: () => ({ value: 'v' }),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('sandbox_escape_attempt');
    });

    it('a host call still returns usable data (a plain context-native object)', () => {
      const r = runInSandbox(
        "(() => { const o = host('kv.get','k'); return typeof o === 'object' && o.value === 'v'; })()",
        { allowedHostCalls: ['kv.get'], hostCall: () => ({ value: 'v' }) },
      );
      expect(r).toEqual({ ok: true, value: true });
    });

    // The subtle one: a host call that THROWS used to hand the sandbox an
    // OUTER-realm Error object — catchable, and `e.constructor.constructor(
    // 'return process')()` escaped. The bridge now carries the failure as a JSON
    // envelope and re-throws an IN-CONTEXT Error, so a caught host-call error can
    // no longer be walked back to the host realm.
    it('blocks escape via an Error caught from a denied/throwing host call', () => {
      const denied = runInSandbox(
        "try { host('fs.read','/etc/passwd') } catch (e) { e.constructor.constructor('return process')(); }",
        { allowedHostCalls: ['kv.get'] },
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe('sandbox_escape_attempt');

      const throwing = runInSandbox(
        "try { host('kv.get','k') } catch (e) { e.constructor.constructor('return process')(); }",
        { allowedHostCalls: ['kv.get'], hostCall: () => { throw new Error('boom'); } },
      );
      expect(throwing.ok).toBe(false);
      if (!throwing.ok) expect(throwing.error.code).toBe('sandbox_escape_attempt');
    });

    it('a denied host call without an escape attempt is classified capability_denied', () => {
      const r = runInSandbox("host('fs.read','/etc/passwd')", { allowedHostCalls: ['kv.get'] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('sandbox_capability_denied');
    });
  });
});
