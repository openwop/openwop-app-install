/**
 * ADR 0130 Phase 5 — the model-router client unwraps the `{ config }` envelope and
 * returns null when no config is set yet (so the page shows "not configured").
 *
 * Breaks if the envelope is returned un-unwrapped (the page would read the
 * `{ config }` wrapper as a stored config) or a `null` config stops reading as
 * "none set yet".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getRouterConfig, type StoredRouterConfig } from '../modelRouterClient.js';

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('getRouterConfig', () => {
  it('returns null when no config exists yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ config: null })));
    expect(await getRouterConfig('org1')).toBeNull();
  });

  it('unwraps the stored config envelope', async () => {
    const config: StoredRouterConfig = { enabled: true, config: { rules: [], fallback: { provider: 'anthropic', model: 'claude-opus-4-8' } } };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ config })));
    const out = await getRouterConfig('org1');
    expect(out).toEqual(config);
  });
});
