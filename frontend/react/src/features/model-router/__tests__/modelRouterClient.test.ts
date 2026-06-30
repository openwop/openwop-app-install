/**
 * ADR 0130 Phase 5 — the model-router client unwraps the `{ config }` envelope and
 * returns null when no config is set yet (so the page shows "not configured").
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getRouterConfig } from '../modelRouterClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('getRouterConfig', () => {
  it('returns null when no config exists yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ config: null }) } as unknown as Response)));
    expect(await getRouterConfig('org1')).toBeNull();
  });

  it('unwraps the stored config envelope', async () => {
    const config = { enabled: true, config: { rules: [], fallback: { provider: 'anthropic', model: 'claude-opus-4-8' } } };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ config }) } as unknown as Response)));
    const out = await getRouterConfig('org1');
    expect(out?.enabled).toBe(true);
    expect(out?.config.fallback.model).toBe('claude-opus-4-8');
  });
});
