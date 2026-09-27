/**
 * ADR 0757 follow-up — the chat binding accepts GitHub Copilot, the RFC 0121
 * CLEARED subscription provider, by its own rule:
 *   - only when the host actually serves Copilot (OAuth client + loopback
 *     sidecar configured — RFC 0121 §B.9);
 *   - only with `credentialRef: subscription:github.copilot`;
 *   - only when the user's OAuth-connected token resolves in THIS tenant.
 * Before this, `setChatByokConfig` refused every provider outside the BYOK key
 * list, so the Copilot tile the SPA now offers had nothing to bind to.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';

const resolveSubscriptionCredential = vi.fn<(ref: string, tenantId: string) => Promise<string | null>>();
vi.mock('../src/byok/subscriptionCredential.js', async (orig) => {
  const real = await orig<typeof import('../src/byok/subscriptionCredential.js')>();
  return { ...real, resolveSubscriptionCredential: (ref: string, tenantId: string) => resolveSubscriptionCredential(ref, tenantId) };
});

const { setChatByokConfig, getChatByokConfig, isChatByokConfigUsable } = await import('../src/host/chatByokConfig.js');

const REF = 'subscription:github.copilot';
const NOW = '2026-09-26T00:00:00.000Z';
let n = 0;
const scope = () => ({ tenantId: `user:copilot-test-${++n}` });

function configure(on: boolean): void {
  if (on) {
    process.env.OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_ID = 'cid';
    process.env.OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_SECRET = 'csecret';
    process.env.OPENWOP_COPILOT_ENDPOINT = 'http://127.0.0.1:8791/v1';
  } else {
    delete process.env.OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_ID;
    delete process.env.OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_SECRET;
    delete process.env.OPENWOP_COPILOT_ENDPOINT;
  }
}

describe('chat binding: GitHub Copilot (ADR 0757 follow-up)', () => {
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
  beforeEach(() => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    resolveSubscriptionCredential.mockReset();
  });
  afterEach(() => configure(false));

  it('binds a connected Copilot subscription on a host that serves Copilot, and reports it usable', async () => {
    configure(true);
    resolveSubscriptionCredential.mockResolvedValue('gho_token');
    const s = scope();
    const row = await setChatByokConfig(s, { provider: 'github.copilot', model: 'default', credentialRef: REF }, NOW);
    expect(row).toMatchObject({ provider: 'github.copilot', model: 'default', credentialRef: REF });
    expect(resolveSubscriptionCredential).toHaveBeenCalledWith(REF, s.tenantId);
    const stored = await getChatByokConfig(s.tenantId);
    expect(stored?.provider).toBe('github.copilot');
    expect(await isChatByokConfigUsable(s, stored!)).toBe(true);
  });

  it('refuses when the host does not serve Copilot (RFC 0121 §B.9)', async () => {
    configure(false);
    resolveSubscriptionCredential.mockResolvedValue('gho_token');
    await expect(setChatByokConfig(scope(), { provider: 'github.copilot', model: 'default', credentialRef: REF }, NOW))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('refuses any other credentialRef for the Copilot provider', async () => {
    configure(true);
    resolveSubscriptionCredential.mockResolvedValue('gho_token');
    await expect(setChatByokConfig(scope(), { provider: 'github.copilot', model: 'default', credentialRef: 'byok:openai' }, NOW))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('refuses when the connected token does not resolve in this tenant', async () => {
    configure(true);
    resolveSubscriptionCredential.mockResolvedValue(null);
    await expect(setChatByokConfig(scope(), { provider: 'github.copilot', model: 'default', credentialRef: REF }, NOW))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('reports a stored Copilot binding unusable once the host stops serving Copilot', async () => {
    configure(true);
    resolveSubscriptionCredential.mockResolvedValue('gho_token');
    const s = scope();
    const row = await setChatByokConfig(s, { provider: 'github.copilot', model: 'default', credentialRef: REF }, NOW);
    configure(false);
    expect(await isChatByokConfigUsable(s, row)).toBe(false);
  });
});
