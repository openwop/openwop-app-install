/**
 * ADR 0121 / RFC 0108 — the compat-endpoint client's gating branches. A 404 means
 * the operator opt-in (OPENWOP_COMPAT_PROVIDER_ENABLED) is off → the card hides
 * (null). A 403 (no scope) throws → the card's catch also hides it. A 200 returns
 * the org's endpoints (key never present, only hasKey).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { listCompatEndpoints } from '../compatClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('listCompatEndpoints — gating', () => {
  it('returns null when the surface is disabled (404 → card hides)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)));
    expect(await listCompatEndpoints('org1')).toBeNull();
  });

  it('returns the endpoints on 200 (no key field, only hasKey)', async () => {
    const endpoints = [{ id: 'compat-1', orgId: 'org1', label: 'Local', baseUrl: 'https://x/v1', hasKey: true, capabilities: { vision: false, tools: true, longContext: false }, createdAt: 't', updatedAt: 't' }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ endpoints }) } as unknown as Response)));
    const out = await listCompatEndpoints('org1');
    expect(out).toHaveLength(1);
    expect(out![0]!.hasKey).toBe(true);
    expect('apiKey' in out![0]!).toBe(false);
  });

  it('throws on 403 (no scope) so the card catch hides it — NOT treated as available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ message: 'forbidden_scope' }) } as unknown as Response)));
    await expect(listCompatEndpoints('org1')).rejects.toThrow();
  });
});
