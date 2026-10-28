/**
 * A FAILED READ of the web-search key must not be reported as "no key configured".
 *
 * `hostWebSearchKeyStatus()` wraps the vault probe in a try/catch so a resolver
 * hiccup cannot 500 the unauthenticated `/readiness` endpoint. That catch is the
 * dangerous kind: swallowed, it would tell an operator who HAD set the key that they
 * had not — the exact false negative this whole surface exists to eliminate, and the
 * failed-read-as-empty family this codebase keeps re-finding.
 *
 * So the contract is three-valued, not two:
 *   configured:true                      → a key resolves
 *   configured:false, no probeError      → genuinely absent
 *   configured:false, probeError present → UNKNOWN; the vault could not be read
 *
 * Lives in its own file because it must mock the secret resolver at module load,
 * which would poison the route-level readiness tests sharing a worker.
 *
 * Witnessed (grade-tests w63): a swallowed failure → case 1 red; probeError on a
 * clean "no" → case 2 red; the env lane gated on a clean vault → case 3 red.
 * Out of scope here (grade-code WEBKEY-PROBEERR-1): `probeError` forwards the
 * resolver's raw message to the unauthenticated /readiness unscrubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as SecretResolver from '../src/byok/secretResolver.js';

const resolveSecret = vi.hoisted(() => vi.fn<typeof SecretResolver.resolveSecret>());
vi.mock('../src/byok/secretResolver.js', () => ({ resolveSecret }));

const load = async () => (await import('../src/host/webResearchSurface.js')).hostWebSearchKeyStatus;

beforeEach(() => { resolveSecret.mockReset(); delete process.env.OPENWOP_WEBSEARCH_API_KEY; });
afterEach(() => { delete process.env.OPENWOP_WEBSEARCH_API_KEY; });

describe('hostWebSearchKeyStatus — a failed read is not an absence', () => {
  it('reports probeError when the vault resolver THROWS and no env key exists', async () => {
    resolveSecret.mockRejectedValue(new Error('vault unreachable: ECONNREFUSED'));
    const status = await (await load())();

    expect(resolveSecret, 'fixture guard: the probe must actually have been attempted').toHaveBeenCalled();
    expect(status.configured).toBe(false);
    expect(status.source).toBeNull();
    // The load-bearing assertion — without this the caller cannot tell "no key"
    // from "could not check", and would report the former for both.
    expect(status.probeError, 'a swallowed resolver failure would read as "not configured"').toContain('ECONNREFUSED');
  });

  it('omits probeError when the key is genuinely absent (resolver answered, said none)', async () => {
    resolveSecret.mockResolvedValue(null);
    const status = await (await load())();
    expect(status).toEqual({ configured: false, source: null });
    expect('probeError' in status, 'a clean "no" must not look like a failure').toBe(false);
  });

  it('a throwing vault still lets the ENV lane answer configured:true', async () => {
    resolveSecret.mockRejectedValue(new Error('vault unreachable'));
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'probe-key-not-real';
    const status = await (await load())();
    expect(status).toEqual({ configured: true, source: 'env' });
  });

  it('carries the error MESSAGE only — no stack, no ref, nothing appended', async () => {
    // The message is attacker-visible: /readiness is unauthenticated. (This case
    // used to assert "no key-shaped string" on a message that never held one, and
    // nothing had been resolved — it could not fail. The contract the code makes
    // is "message only", so that is what is pinned, exactly.)
    const err = new Error('failed for ref web-search');
    resolveSecret.mockRejectedValue(err);
    const status = await (await load())();
    expect(status).toEqual({ configured: false, source: null, probeError: 'failed for ref web-search' });
    expect(err.stack, 'fixture guard: the error carries a stack that must not leak').toContain('at ');
  });
});
