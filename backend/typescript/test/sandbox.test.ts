/**
 * A13 — real vm sandbox (RFC 0035, `host/sandbox.ts runInSandbox`). Verifies
 * isolation + the failure taxonomy: success, capability-denied, escape-attempt,
 * timeout, and the AGENTRT-1 prototype-chain escape hardening.
 *
 * Every refusal is asserted as one whole result (`ok:false` + the exact code,
 * plus the message where it names the cause), so an escape that SUCCEEDS
 * (`ok:true` with the real `process`) or a refusal for an unrelated reason
 * cannot pass.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): a host-call failure re-thrown
 * as an outer-realm object (`8fw2g3-sbx-errrealm`), the host Proxy handing out
 * an outer constructor (`-sbx-hostctor`), host-call results left outer-realm
 * (`-sbx-retrealm`), the timeout pattern broken (`-sbx-timeout`), the
 * ReferenceError classification removed (`-sbx-escape`), and the allow-list
 * check removed (`-sbx-allow`).
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
    expect(denied).toMatchObject({ ok: false, error: { code: 'sandbox_capability_denied', message: expect.stringContaining('fs.read') } });
  });

  it('reports an escape attempt when reaching for ambient globals', () => {
    const r = runInSandbox("require('node:fs')");
    expect(r).toMatchObject({ ok: false, error: { code: 'sandbox_escape_attempt', message: expect.stringMatching(/require is not defined/) } });

    const p = runInSandbox('process.env.SECRET');
    expect(p).toMatchObject({ ok: false, error: { code: 'sandbox_escape_attempt', message: expect.stringMatching(/process is not defined/) } });
  });

  it('times out a runaway synchronous loop', () => {
    const r = runInSandbox('while (true) {}', { timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false, error: { code: 'sandbox_timeout' } });
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
      expect(r).toMatchObject({ ok: false, error: { code: 'sandbox_escape_attempt', message: expect.stringMatching(/process is not defined/) } });
    });

    it('blocks the generic Function-constructor escape', () => {
      const r = runInSandbox("[].constructor.constructor('return process')()");
      expect(r).toMatchObject({ ok: false, error: { code: 'sandbox_escape_attempt', message: expect.stringMatching(/process is not defined/) } });
    });

    it('blocks escape via a host-call return value (results are context-native)', () => {
      const r = runInSandbox("host('kv.get','k').constructor.constructor('return process')()", {
        allowedHostCalls: ['kv.get'],
        hostCall: () => ({ value: 'v' }),
      });
      expect(r).toMatchObject({ ok: false, error: { code: 'sandbox_escape_attempt', message: expect.stringMatching(/process is not defined/) } });
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
      expect(denied).toMatchObject({ ok: false, error: { code: 'sandbox_escape_attempt', message: expect.stringMatching(/process is not defined/) } });

      const throwing = runInSandbox(
        "try { host('kv.get','k') } catch (e) { e.constructor.constructor('return process')(); }",
        { allowedHostCalls: ['kv.get'], hostCall: () => { throw new Error('boom'); } },
      );
      expect(throwing).toMatchObject({ ok: false, error: { code: 'sandbox_escape_attempt', message: expect.stringMatching(/process is not defined/) } });
    });

    // Twin of the denied leg in 'allows only allow-listed host calls' (same call, same
    // allow-list), kept here as the control for the caught-error escape case above: with
    // no `constructor` walk, the SAME denied call is capability_denied, not an escape.
    it('a denied host call without an escape attempt is classified capability_denied', () => {
      const r = runInSandbox("host('fs.read','/etc/passwd')", { allowedHostCalls: ['kv.get'] });
      expect(r).toMatchObject({ ok: false, error: { code: 'sandbox_capability_denied', message: expect.stringContaining('fs.read') } });
    });
  });
});
