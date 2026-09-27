/**
 * ADR 0201 — SMTP TCP-egress firewall (`smtpEgress.ts`). Proves the dial is
 * fail-closed: port allowlist, the reused per-tenant ADR 0187 policy, and — the
 * load-bearing bit — rebind-safe SSRF validation of the RESOLVED address (a host
 * that resolves to a private IP is refused BEFORE any socket, closing the
 * DNS-rebinding TOCTOU). `node:dns` is mocked so no real resolution/network runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Map test hostnames → resolved addresses; IP literals pass through unchanged.
vi.mock('node:dns', () => {
  const RESOLVE: Record<string, Array<{ address: string; family: number }>> = {
    'rebind.evil.test': [{ address: '10.0.0.5', family: 4 }], // public name → private IP (rebind)
    'good.smtp.test': [{ address: '93.184.216.34', family: 4 }], // public
    'metadata.rebind.test': [{ address: '169.254.169.254', family: 4 }], // cloud metadata
  };
  const lookup = (host: string, _opts: unknown, cb: (e: Error | null, a: unknown) => void): void => {
    const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    cb(null, isIpv4 ? [{ address: host, family: 4 }] : (RESOLVE[host] ?? []));
  };
  return { lookup, default: { lookup } };
});

import { createApp } from '../src/index.js';
import { assertSmtpDialAllowed } from '../src/host/smtpEgress.js';
import { putEgressRules } from '../src/host/egressPolicy.js';

const T = 'tsmtp-fw';

describe('smtpEgress — TCP-egress firewall (ADR 0201)', () => {
  beforeAll(async () => {
    // SSRF baseline MUST be active for these assertions — ensure the dev bypass is off.
    delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  });
  afterAll(() => { /* leave env as-is */ });

  const blocked = async (host: string, port: number, reason: string): Promise<void> => {
    await expect(assertSmtpDialAllowed(T, host, port)).rejects.toMatchObject({ code: 'egress_blocked', details: { reason } });
  };

  it('rejects a non-submission port before anything else', async () => {
    await blocked('good.smtp.test', 25, 'port_not_allowed');
    await blocked('good.smtp.test', 8025, 'port_not_allowed');
  });

  it('allows a public host on a submission port and returns the PINNED resolved IP', async () => {
    const t = await assertSmtpDialAllowed(T, 'good.smtp.test', 587);
    expect(t).toMatchObject({ host: 'good.smtp.test', address: '93.184.216.34', port: 587 });
  });

  it('REBIND-SAFE: refuses a host that RESOLVES to a private IP (no socket opened)', async () => {
    await blocked('rebind.evil.test', 465, 'ssrf_private_range');
    await blocked('metadata.rebind.test', 587, 'ssrf_private_range'); // 169.254.169.254 cloud metadata
  });

  it('refuses a private/loopback IP literal at the host-policy step', async () => {
    await blocked('10.1.2.3', 587, 'ssrf_private_range');
    await blocked('127.0.0.1', 465, 'ssrf_private_range');
  });

  it('honors the per-tenant ADR 0187 allowlist (shared policy, not a second firewall)', async () => {
    await putEgressRules(T, 'allowlist', ['good.smtp.test']);
    const t = await assertSmtpDialAllowed(T, 'good.smtp.test', 587);
    expect(t.address).toBe('93.184.216.34');
    await blocked('other-public.smtp.test', 587, 'not_on_allowlist'); // resolves to [] but policy denies first
    await putEgressRules(T, 'off', []); // reset
  });

  it('honors the per-tenant denylist', async () => {
    await putEgressRules(T, 'denylist', ['good.smtp.test']);
    await blocked('good.smtp.test', 587, 'denylist_match');
    await putEgressRules(T, 'off', []);
  });
});
