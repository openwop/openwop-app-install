/**
 * ADR 0187 — application-layer egress firewall. Pure evaluator tests: the SSRF
 * baseline is never relaxed; allowlist is default-deny; denylist is default-allow;
 * host rules match subdomains (suffix). Plus the store round-trip + fail-closed
 * assert.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { evaluateEgress, getEgressRules, putEgressRules, assertEgressAllowed, type EgressRuleSet } from '../src/host/egressPolicy.js';
import { OpenwopError } from '../src/types.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';

beforeAll(async () => {
  initHostExtPersistence(await openSqliteStorage('memory://'));
});

const rules = (mode: EgressRuleSet['mode'], hosts: string[]): EgressRuleSet => ({ tenantId: 't', mode, hosts });

describe('evaluateEgress — SSRF baseline (never relaxed)', () => {
  it('denies private/loopback/metadata even under an allowlist that names them', () => {
    for (const url of ['http://localhost/x', 'http://127.0.0.1/x', 'http://169.254.169.254/latest', 'http://10.0.0.5/x', 'http://metadata.google.internal/x']) {
      const v = evaluateEgress(url, rules('allowlist', ['localhost', '127.0.0.1', '169.254.169.254', '10.0.0.5', 'metadata.google.internal']));
      expect(v.allowed, url).toBe(false);
      expect(v.reason).toBe('ssrf_private_range');
    }
  });
  it('denies an invalid URL', () => {
    expect(evaluateEgress('not a url', rules('off', [])).allowed).toBe(false);
  });
});

describe('evaluateEgress — mode off', () => {
  it('allows any public host (SSRF baseline only)', () => {
    expect(evaluateEgress('https://api.example.com/x', rules('off', [])).allowed).toBe(true);
  });
});

describe('evaluateEgress — denylist (default allow)', () => {
  it('denies a matching host + its subdomains, allows others', () => {
    const r = rules('denylist', ['evil.com']);
    expect(evaluateEgress('https://evil.com/x', r).allowed).toBe(false);
    expect(evaluateEgress('https://api.evil.com/x', r).allowed).toBe(false); // subdomain suffix
    expect(evaluateEgress('https://notevil.com/x', r).allowed).toBe(true);   // NOT a suffix match
    expect(evaluateEgress('https://good.com/x', r).allowed).toBe(true);
  });
});

describe('evaluateEgress — allowlist (default deny)', () => {
  it('allows only listed hosts + subdomains, denies the rest', () => {
    const r = rules('allowlist', ['example.com']);
    expect(evaluateEgress('https://example.com/x', r).allowed).toBe(true);
    expect(evaluateEgress('https://api.example.com/x', r).allowed).toBe(true);
    expect(evaluateEgress('https://other.com/x', r).allowed).toBe(false);
    expect(evaluateEgress('https://notexample.com/x', r).reason).toBe('not_on_allowlist');
  });
});

describe('store round-trip + assertEgressAllowed', () => {
  beforeEach(async () => { await putEgressRules('tenantA', 'off', []); });

  it('defaults to off when unset', async () => {
    const r = await getEgressRules('never-set-tenant');
    expect(r.mode).toBe('off');
    expect(r.hosts).toEqual([]);
  });

  it('normalizes + de-dupes hosts on put', async () => {
    const saved = await putEgressRules('tenantA', 'allowlist', ['  Example.COM ', 'example.com', '.foo.com.']);
    expect(saved.hosts.sort()).toEqual(['example.com', 'foo.com']);
  });

  it('assertEgressAllowed throws egress_blocked/403 on a denied host', async () => {
    await putEgressRules('tenantA', 'allowlist', ['example.com']);
    await expect(assertEgressAllowed('tenantA', 'https://evil.com/x')).rejects.toMatchObject(
      { code: 'egress_blocked', httpStatus: 403 },
    );
    // and does NOT throw for an allowed host
    await expect(assertEgressAllowed('tenantA', 'https://api.example.com/x')).resolves.toBeUndefined();
  });

  it('assertEgressAllowed throws for the SSRF baseline regardless of tenant policy', async () => {
    await putEgressRules('tenantA', 'off', []);
    await expect(assertEgressAllowed('tenantA', 'http://169.254.169.254/latest')).rejects.toBeInstanceOf(OpenwopError);
  });
});
